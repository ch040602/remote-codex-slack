import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../config.js";
import type { BridgeConfig, SkillDef } from "../config.js";
import type { PathResolver, ResolvedWorkspace } from "../core/pathResolver.js";
import type { LanguageCode, PendingCommand, SendPolicy, SessionCommandRecord, Store, SlackThreadBinding } from "../core/store.js";
import type { SkillRegistry } from "../core/skills.js";
import { listCodexCliSessions, type CodexCliSessionCommand } from "../codex/sessionIndex.js";
import type { CodexRuntime, TurnCompletedEvent } from "../codex/controllerTypes.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { commandTarget, hasOption, isPlainSlackChannelMessage, normalizeSlackMessageText, optionString, parseCommand, stripBotMention } from "../commands/parser.js";
import { COMMAND_HELP, commandSuggestions, renderCommandSuggestions, type CommandSuggestion } from "../commands/catalog.js";
import type { ParsedCommand } from "../commands/types.js";
import { splitForSlack, codeBlock } from "./messageUtils.js";

interface CommandContext {
  userId: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  isSlash: boolean;
  rawText: string;
  bypassCommandLookup?: boolean;
  preferRespond?: boolean;
  client: WebClient;
  respond?: (message: any) => Promise<any>;
}

interface AssistActionValue {
  kind: "command" | "skill" | "bind-session" | "session-action" | "pending-action" | "rerun-action" | "ref";
  command?: string;
  rawText?: string;
  sessionId?: string;
  pendingId?: string;
  token?: string;
}

const DIRECT_RUN_COMMANDS = new Set(["help", "projects", "skills", "pwd", "ls", "recent", "sessions", "active", "history", "pending", "status", "bind-session", "session", "send-mode", "send-policy"]);
const DEFAULT_LINKED_SEND_POLICY: SendPolicy = "pending";
const RECENT_SESSIONS_CACHE_MS = 5000;
const MAX_SKILL_PICKER_OPTIONS = 50;
const SLACK_OPTION_VALUE_LIMIT = 75;
const ASSIST_ACTION_CACHE_MS = 10 * 60 * 1000;
const assistActionCache = new Map<string, { expiresAt: number; value: AssistActionValue }>();

interface CommandLookupResult {
  query: string;
  suggestions: CommandSuggestion[];
}

export class SlackBridge {
  readonly app: App;
  private recentSessionsCache?: { expiresAt: number; limit: number; sessions: SlackThreadBinding[] };

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: Store,
    private readonly paths: PathResolver,
    private readonly skills: SkillRegistry,
    private readonly codex: CodexRuntime
  ) {
    this.app = new App({
      token: env.slackBotToken,
      appToken: env.slackAppToken,
      signingSecret: env.slackSigningSecret || "placeholder",
      socketMode: true
    });

    this.codex.on("turnCompleted", (event) => this.onTurnCompleted(event));
    this.registerHandlers();
  }

  async start() {
    await this.app.start();
    logger.info("Slack bridge started in Socket Mode");
  }

  private registerHandlers() {
    this.app.command("/codex", async ({ command, ack, respond, client }) => {
      await ack();
      await this.handleCommand({
        userId: command.user_id,
        channelId: command.channel_id,
        channelName: command.channel_name,
        isSlash: true,
        rawText: command.text,
        client,
        respond
      });
    });

    this.app.event("app_mention", async ({ event, client }) => {
      const ev = event as any;
      if (!ev.text || ev.bot_id) return;
      await this.handleCommand({
        userId: ev.user,
        channelId: ev.channel,
        threadTs: ev.thread_ts ?? ev.ts,
        messageTs: ev.ts,
        isSlash: false,
        rawText: stripBotMention(ev.text),
        client
      });
    });

    this.app.message(async ({ message, client }) => {
      const msg = message as { bot_id?: string; text?: string; user?: string; channel: string; channel_type?: string; thread_ts?: string; ts: string };
      if (msg.bot_id || !msg.text || !msg.user) return;
      const isDirectMessage = msg.channel_type === "im";
      const isPlainChannelMessage = isPlainSlackChannelMessage(msg.text, env.commandPrefix, isDirectMessage);
      if (isPlainChannelMessage && !this.isSendModeEnabled(msg.channel, msg.thread_ts)) return;
      const rawText = normalizeSlackMessageText(msg.text, env.commandPrefix, isDirectMessage);
      if (rawText === undefined) return;
      await this.handleCommand({
        userId: msg.user,
        channelId: msg.channel,
        threadTs: msg.thread_ts ?? msg.ts,
        messageTs: msg.ts,
        isSlash: false,
        rawText,
        bypassCommandLookup: isPlainChannelMessage,
        client
      });
    });

    this.app.action("codex_command_select", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });

    this.app.action("codex_skill_select", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });

    this.app.action("codex_session_bind_select", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });

    this.app.action("codex_session_action", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });

    this.app.action("codex_pending_action", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });

    this.app.action("codex_rerun_select", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });

    this.app.action("codex_rerun_action", async ({ ack, body, client, respond }: any) => {
      await ack();
      await this.handleAssistAction(body, client, respond);
    });
  }

  private async handleCommand(ctx: CommandContext) {
    try {
      if (!this.isAllowed(ctx.userId)) {
        await this.reply(ctx, "Not allowed.");
        return;
      }

      const parsed = parseCommand(ctx.rawText);
      logger.info("slack command", { userId: ctx.userId, channelId: ctx.channelId, name: parsed.name });

      const commandLookup = this.commandLookup(ctx, parsed);
      if (commandLookup !== undefined) {
        await this.replyWithBlocks(ctx, this.commandAssistMessage(commandLookup.query, this.currentLanguage(ctx), commandLookup.suggestions));
        return;
      }

      if (this.isChannelCreationShortcut(ctx, parsed)) {
        await this.handleCreateChannelShortcut(ctx, parsed.rawArgs);
        return;
      }

      switch (parsed.name) {
        case "help":
          await this.replyWithBlocks(ctx, {
            text: helpText(env.commandPrefix, this.currentLanguage(ctx)),
            blocks: commandPickerBlocks(this.currentLanguage(ctx), "")
          });
          return;
        case "commands":
          await this.replyWithBlocks(ctx, this.commandAssistMessage(parsed.args.join(" ").trim(), this.currentLanguage(ctx)));
          return;
        case "projects":
          await this.reply(ctx, this.renderProjects());
          return;
        case "skills":
          await this.replyWithBlocks(ctx, this.skillAssistMessage(parsed.args.join(" ").trim(), ctx.rawText));
          return;
        case "language":
        case "lang":
        case "언어":
          await this.handleLanguage(ctx, parsed);
          return;
        case "use":
        case "cd":
          await this.handleUse(ctx, parsed);
          return;
        case "pwd":
          await this.handlePwd(ctx);
          return;
        case "ls":
          await this.handleLs(ctx, parsed);
          return;
        case "bind-session":
          await this.handleBindSession(ctx, parsed);
          return;
        case "unbind-session":
          await this.handleUnbindSession(ctx);
          return;
        case "new":
          await this.handleNew(ctx, parsed);
          return;
        case "send":
          await this.handleSend(ctx, parsed);
          return;
        case "send-mode":
          await this.handleSendMode(ctx, parsed);
          return;
        case "send-policy":
          await this.handleSendPolicy(ctx, parsed);
          return;
        case "session":
        case "s":
          await this.handleSessionMenu(ctx);
          return;
        case "steer":
          await this.handleSteer(ctx, parsed);
          return;
        case "resume":
          await this.handleResume(ctx, parsed);
          return;
        case "rerun":
          await this.handleRerun(ctx, parsed);
          return;
        case "rerun-session":
          await this.handleRerunSession(ctx, parsed);
          return;
        case "recent":
        case "sessions":
          await this.handleSessions(ctx, parsed);
          return;
        case "active":
          await this.handleActiveSessions(ctx, parsed);
          return;
        case "history":
          await this.handleHistory(ctx, parsed);
          return;
        case "rerun-command":
          await this.handleRerunCommand(ctx, parsed);
          return;
        case "pending":
          await this.handlePending(ctx);
          return;
        case "pending-edit":
          await this.handlePendingEdit(ctx, parsed);
          return;
        case "pending-drop":
          await this.handlePendingDrop(ctx, parsed);
          return;
        case "pending-run":
          await this.handlePendingRun(ctx, parsed);
          return;
        case "status":
          await this.handleStatus(ctx);
          return;
        case "stop":
          await this.handleStop(ctx);
          return;
        default:
          if (this.isSkillLookupShortcut(parsed)) {
            await this.replyWithBlocks(ctx, this.skillAssistMessage(parsed.rawArgs.slice(1), ctx.rawText));
            return;
          }
          await this.reply(ctx, "Unknown command. Use `help`.");
      }
    } catch (error) {
      logger.error("command failed", errorDetails(error));
      await this.reply(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isAllowed(userId: string) {
    return env.allowAllSlackUsers || env.allowedSlackUserIds.includes(userId);
  }

  private commandLookup(_ctx: CommandContext, parsed: ParsedCommand): CommandLookupResult | undefined {
    if (_ctx.bypassCommandLookup) return undefined;
    const raw = parsed.rawArgs.trim();
    if (parsed.name !== "send" || !parsed.implicitSend) return undefined;
    if (!raw || raw.startsWith("$")) return undefined;
    if (raw === "?") return { query: "", suggestions: commandSuggestions("", 10) };

    const first = raw.split(/\s+/)[0];
    if (!/^[A-Za-z가-힣?_-]+$/.test(first)) return undefined;
    const suggestions = commandSuggestions(first, 10);
    return suggestions.length > 0 ? { query: first, suggestions } : undefined;
  }

  private async handleUse(ctx: CommandContext, cmd: ParsedCommand) {
    const target = commandTarget(cmd, "channel");
    if (!target) {
      await this.reply(ctx, "Usage: `use <project|path>` or `cd <project|path>`");
      return;
    }
    const current = this.currentWorkspace(ctx);
    const resolved = this.paths.resolve(target, current.cwd);
    this.paths.ensureExists(resolved.cwd);

    const threadTs = ctx.threadTs;
    if (threadTs && !hasOption(cmd, "channel")) {
      const key = this.store.threadKey(ctx.channelId, threadTs);
      const existing = this.store.getThreadBinding(key);
      const now = new Date().toISOString();
      this.store.upsertThreadBinding({
        key,
        channelId: ctx.channelId,
        threadTs,
        cwd: resolved.cwd,
        projectName: resolved.projectName,
        codexThreadId: existing?.codexThreadId,
        activeTurnId: existing?.activeTurnId,
        status: existing?.status ?? "idle",
        lastPrompt: existing?.lastPrompt,
        lastFinalAnswer: existing?.lastFinalAnswer,
        title: existing?.title,
        sendMode: existing?.sendMode,
        sendPolicy: existing?.sendPolicy,
        language: existing?.language,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        createdBy: existing?.createdBy ?? ctx.userId
      });
      this.invalidateRecentSessions();
      await this.reply(ctx, `Thread workspace set to: ${codeInline(resolved.cwd)}`);
      return;
    }

    this.store.setChannelBinding({
      channelId: ctx.channelId,
      cwd: resolved.cwd,
      projectName: resolved.projectName,
      language: this.currentLanguage(ctx),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId
    });
    this.invalidateRecentSessions();
    await this.reply(ctx, `Channel workspace set to: ${codeInline(resolved.cwd)}`);
  }

  private async handleCreateChannelShortcut(ctx: CommandContext, channelNameRaw: string) {
    const channelName = normalizeSlackChannelName(channelNameRaw);
    if (!channelName) {
      await this.reply(ctx, "Usage: `/codex <new-channel-name>`");
      return;
    }

    const root = this.navigationRoot();
    const channelId = await this.createOrReuseSlackChannel(ctx.client, channelName);
    this.store.setChannelBinding({
      channelId,
      cwd: root,
      language: this.currentLanguage(ctx),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId
    });

    await this.postThread(ctx, channelId, undefined, [
      `Channel created for Codex navigation: ${codeInline(`#${channelName}`)}`,
      `cwd: ${codeInline(root)}`,
      "Use `/codex ls`, `/codex cd <folder>`, `/codex pwd`, then `/codex new ...` to queue work.",
      "The first real Codex command fixes this channel to the selected workspace/session."
    ].join("\n"));
    await this.reply(ctx, `Created or reused ${codeInline(`#${channelName}`)} with cwd ${codeInline(root)}.`);
  }

  private async handleBindSession(ctx: CommandContext, cmd: ParsedCommand) {
    const selector = cmd.args[0];
    const recent = this.listRecentSessions(15);
    if (recent.length === 0) {
      await this.reply(ctx, "No Codex sessions found.");
      return;
    }
    if (!selector) {
      const language = this.currentLanguage(ctx);
      const text = renderBindSessionList(recent, language);
      await this.replyWithBlocks(ctx, {
        text,
        blocks: bindSessionPickerBlocks(recent, language, text)
      });
      return;
    }

    const session = this.resolveRecentSession(ctx, selector);
    if (!session) throw new Error(`No recent Codex session found for selector: ${selector}`);
    await this.bindSessionToHere(ctx, session);
  }

  private async handleSessionMenu(ctx: CommandContext) {
    const language = this.currentLanguage(ctx);
    const workspace = this.currentWorkspace(ctx);
    const binding = this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
    const sendMode = this.sendModeForContext(ctx);
    const sendPolicy = this.sendPolicyForContext(ctx);
    const text = renderSessionQuickText(workspace, binding, language, sendMode, sendPolicy);
    await this.replyWithBlocks(ctx, {
      text,
      blocks: sessionQuickActionBlocks(language, text, sendMode, sendPolicy)
    });
  }

  private async handleSessionAction(ctx: CommandContext, action: string) {
    switch (action) {
      case "new-same-repo":
        await this.createSameRepoSessionSlot(ctx);
        return;
      case "bind-recent":
        await this.handleBindSession(ctx, parseCommand("bind-session"));
        return;
      case "unbind-session":
        await this.handleUnbindSession(ctx);
        return;
      case "send-mode-on":
        await this.setSendMode(ctx, true);
        return;
      case "send-mode-off":
        await this.setSendMode(ctx, false);
        return;
      case "send-policy-immediate":
        await this.setSendPolicy(ctx, "immediate");
        return;
      case "send-policy-confirm":
        await this.setSendPolicy(ctx, "confirm");
        return;
      case "send-policy-pending":
        await this.setSendPolicy(ctx, "pending");
        return;
      case "status":
        await this.handleStatus(ctx);
        return;
      case "recent":
        await this.handleSessions(ctx, parseCommand("recent"));
        return;
      default:
        await this.reply(ctx, `Unknown session action: ${action}`);
    }
  }

  private async createSameRepoSessionSlot(ctx: CommandContext) {
    const workspace = this.currentWorkspace(ctx);
    this.paths.ensureExists(workspace.cwd);
    this.fixChannelWorkspace(ctx, workspace);

    const threadContext = await this.ensureSlackThread({ ...ctx, threadTs: undefined }, `Codex session: ${workspace.projectName ?? workspace.cwd}`);
    const key = this.store.threadKey(threadContext.channelId, threadContext.threadTs);
    const binding = await this.codex.createThread({
      slackKey: key,
      channelId: threadContext.channelId,
      threadTs: threadContext.threadTs,
      cwd: workspace.cwd,
      projectName: workspace.projectName,
      createdBy: ctx.userId,
      title: "New session"
    });
    const sendMode = this.sendModeForContext(ctx);
    const linkedBinding = this.store.updateThread(binding.key, { sendMode, sendPolicy: DEFAULT_LINKED_SEND_POLICY });
    this.invalidateRecentSessions();
    await this.postThreadWithBlocks(ctx.client, threadContext.channelId, threadContext.threadTs, {
      text: [
      "New same-repo Codex session linked.",
      `cwd: ${codeInline(workspace.cwd)}`,
      linkedBinding.codexThreadId ? `codexThreadId: ${codeInline(linkedBinding.codexThreadId)}` : "codexThreadId: pending until the first CLI turn starts",
      sendMode
        ? `Send policy was set to ${codeInline(DEFAULT_LINKED_SEND_POLICY)} for safety. Change it?`
        : "Send mode is off. Use `send <prompt>` / `send -f <prompt>`, or turn send mode on before sending normal chat."
      ].join("\n"),
      blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), [
        "New same-repo Codex session linked.",
        `cwd: ${codeInline(workspace.cwd)}`,
        `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
        "Change send policy?"
      ].join("\n"))
    });
  }

  private async handleSendMode(ctx: CommandContext, cmd: ParsedCommand) {
    const requested = normalizeSendMode(cmd.args[0]);
    if (requested === undefined) {
      await this.reply(ctx, renderSendModeStatus(this.sendModeForContext(ctx), this.currentLanguage(ctx)));
      return;
    }
    await this.setSendMode(ctx, requested);
  }

  private async handleSendPolicy(ctx: CommandContext, cmd: ParsedCommand) {
    const requested = normalizeSendPolicy(cmd.args[0]);
    if (!requested) {
      await this.reply(ctx, renderSendPolicyStatus(this.sendPolicyForContext(ctx), this.currentLanguage(ctx)));
      return;
    }
    await this.setSendPolicy(ctx, requested);
  }

  private async setSendMode(ctx: CommandContext, enabled: boolean) {
    const workspace = this.currentWorkspace(ctx);
    const now = new Date().toISOString();
    if (ctx.threadTs) {
      const key = this.store.threadKey(ctx.channelId, ctx.threadTs);
      const existing = this.store.getThreadBinding(key);
      if (existing) {
        this.store.updateThread(key, { sendMode: enabled });
      } else {
        this.store.upsertThreadBinding({
          key,
          channelId: ctx.channelId,
          threadTs: ctx.threadTs,
          cwd: workspace.cwd,
          projectName: workspace.projectName,
          sendMode: enabled,
          sendPolicy: this.sendPolicyForContext(ctx),
          status: "idle",
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId
        });
      }
    } else {
      this.store.setChannelBinding({
        channelId: ctx.channelId,
        cwd: workspace.cwd,
        projectName: workspace.projectName,
        sendMode: enabled,
        language: this.currentLanguage(ctx),
        updatedAt: now,
        updatedBy: ctx.userId
      });
    }
    await this.reply(ctx, renderSendModeStatus(enabled, this.currentLanguage(ctx)));
  }

  private async setSendPolicy(ctx: CommandContext, policy: SendPolicy) {
    const workspace = this.currentWorkspace(ctx);
    const now = new Date().toISOString();
    if (ctx.threadTs) {
      const key = this.store.threadKey(ctx.channelId, ctx.threadTs);
      const existing = this.store.getThreadBinding(key);
      if (existing) {
        this.store.updateThread(key, { sendPolicy: policy });
      } else {
        this.store.upsertThreadBinding({
          key,
          channelId: ctx.channelId,
          threadTs: ctx.threadTs,
          cwd: workspace.cwd,
          projectName: workspace.projectName,
          sendMode: this.sendModeForContext(ctx),
          sendPolicy: policy,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId
        });
      }
    } else {
      this.store.setChannelBinding({
        channelId: ctx.channelId,
        cwd: workspace.cwd,
        projectName: workspace.projectName,
        sendPolicy: policy,
        language: this.currentLanguage(ctx),
        updatedAt: now,
        updatedBy: ctx.userId
      });
    }
    await this.reply(ctx, renderSendPolicyStatus(policy, this.currentLanguage(ctx)));
  }

  private async handleUnbindSession(ctx: CommandContext) {
    const binding = this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
    if (!binding) {
      await this.reply(ctx, "No session binding found here.");
      return;
    }
    this.store.removeThreadBinding(binding.key);
    this.invalidateRecentSessions();
    await this.reply(ctx, [
      "Session binding removed.",
      `cwd remains: ${codeInline(this.currentWorkspace(ctx).cwd)}`,
      "Use `session` to bind another session or create a new same-repo session."
    ].join("\n"));
  }

  private async handlePwd(ctx: CommandContext) {
    const workspace = this.currentWorkspace(ctx);
    const binding = this.currentThreadBinding(ctx);
    await this.reply(
      ctx,
      [
        `cwd: ${codeInline(workspace.cwd)}`,
        workspace.projectName ? `project: ${codeInline(workspace.projectName)}` : undefined,
        binding?.codexThreadId ? `codexThreadId: ${codeInline(binding.codexThreadId)}` : undefined,
        binding?.status ? `status: ${codeInline(binding.status)}` : undefined,
        `sendMode: ${codeInline(this.sendModeForContext(ctx) ? "on" : "off")}`,
        `sendPolicy: ${codeInline(this.sendPolicyForContext(ctx))}`
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  private async handleLs(ctx: CommandContext, cmd: ParsedCommand) {
    const workspace = this.currentWorkspace(ctx);
    const targetArg = cmd.args.join(" ").trim();
    const target = targetArg ? this.paths.resolve(targetArg, workspace.cwd).cwd : workspace.cwd;
    this.paths.ensureExists(target);
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 80)
      .map((entry) => `${entry.isDirectory() ? "[d]" : "   "} ${entry.name}`);
    await this.reply(ctx, [`cwd: ${codeInline(target)}`, codeBlock(entries.join("\n") || "(empty)")].join("\n"));
  }

  private async handleNew(ctx: CommandContext, cmd: ParsedCommand) {
    const workspace = this.workspaceFromCommandOrContext(ctx, cmd);
    this.paths.ensureExists(workspace.cwd);
    const prompt = this.promptFrom(cmd, { allowProjectFirstArg: true });
    if (!prompt) {
      await this.reply(ctx, "Usage: `new [-f|--force] [--cwd projectOrPath] <prompt>`");
      return;
    }
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;

    await this.executeBySendPolicy(
      ctx,
      cmd,
      {
        command: "new",
        prompt,
        cwd: workspace.cwd,
        projectName: workspace.projectName
      },
      () => this.startNewTurn(ctx, workspace, prompt)
    );
  }

  private async startNewTurn(ctx: CommandContext, workspace: ResolvedWorkspace, prompt: string) {
    this.paths.ensureExists(workspace.cwd);
    this.fixChannelWorkspace(ctx, workspace);

    const threadContext = await this.ensureSlackThread(ctx, `Codex session: ${workspace.projectName ?? workspace.cwd}`);
    const key = this.store.threadKey(threadContext.channelId, threadContext.threadTs);
    const binding = await this.codex.createThread({
      slackKey: key,
      channelId: threadContext.channelId,
      threadTs: threadContext.threadTs,
      cwd: workspace.cwd,
      projectName: workspace.projectName,
      createdBy: ctx.userId,
      title: prompt.slice(0, 80)
    });
    const linkedBinding = this.store.updateThread(binding.key, { sendPolicy: DEFAULT_LINKED_SEND_POLICY });
    this.invalidateRecentSessions();
    const { turnId, referencedSkills } = await this.codex.startTurn(linkedBinding, prompt);
    this.recordSessionCommand(ctx, linkedBinding, "new", prompt);
    await this.postThreadWithBlocks(ctx.client, threadContext.channelId, threadContext.threadTs, {
      text: [
      `Started Codex turn ${codeInline(turnId)} in ${codeInline(workspace.cwd)}.`,
      `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
      ].filter(Boolean).join("\n"),
      blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), [
        `Started Codex turn ${codeInline(turnId)} in ${codeInline(workspace.cwd)}.`,
        `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
        "Change send policy?"
      ].join("\n"))
    });
  }

  private async handleSend(ctx: CommandContext, cmd: ParsedCommand) {
    const prompt = commandPrompt(cmd) || ctx.rawText;
    if (!prompt) {
      await this.reply(ctx, "Usage: `send [-f|--force] <prompt>`");
      return;
    }
    if (this.isSkillLookupText(prompt)) {
      await this.replyWithBlocks(ctx, this.skillAssistMessage(prompt.slice(1), ctx.rawText));
      return;
    }
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;
    await this.executeBySendPolicy(ctx, cmd, { command: "send", prompt }, () => this.startSend(ctx, prompt));
  }

  private async startSend(ctx: CommandContext, prompt: string) {
    let binding = this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
    let createdBinding = false;
    if (!binding?.codexThreadId) {
      const workspace = this.currentWorkspace(ctx);
      this.fixChannelWorkspace(ctx, workspace);
      const threadContext = await this.ensureSlackThread(ctx, `Codex session: ${workspace.projectName ?? workspace.cwd}`);
      const key = this.store.threadKey(threadContext.channelId, threadContext.threadTs);
      binding = await this.codex.createThread({
        slackKey: key,
        channelId: threadContext.channelId,
        threadTs: threadContext.threadTs,
        cwd: workspace.cwd,
        projectName: workspace.projectName,
        createdBy: ctx.userId,
        title: prompt.slice(0, 80)
      });
      binding = this.store.updateThread(binding.key, { sendPolicy: DEFAULT_LINKED_SEND_POLICY });
      this.invalidateRecentSessions();
      createdBinding = true;
    }
    const { turnId, referencedSkills } = await this.codex.sendOrSteer(binding, prompt);
    this.recordSessionCommand(ctx, binding, "send", prompt);
    const text = [
      `Sent to Codex turn ${codeInline(turnId)}.`,
      createdBinding ? `New session linked with send policy ${codeInline(DEFAULT_LINKED_SEND_POLICY)}.` : undefined,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
    ].filter(Boolean).join("\n");
    if (createdBinding) {
      await this.postThreadWithBlocks(ctx.client, binding.channelId, binding.threadTs, {
        text: `${text}\nChange send policy?`,
        blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), `${text}\nChange send policy?`)
      });
    } else {
      await this.postThread(ctx.client, binding.channelId, binding.threadTs, text);
    }
  }

  private async handleSteer(ctx: CommandContext, cmd: ParsedCommand) {
    const binding = this.requireCurrentBinding(ctx);
    const prompt = cmd.rawArgs;
    if (!prompt) {
      await this.reply(ctx, "Usage: `steer <prompt>`");
      return;
    }
    const { turnId, referencedSkills } = await this.codex.steer(binding, prompt);
    await this.postThread(ctx.client, binding.channelId, binding.threadTs, [
      `Steered active turn ${codeInline(turnId)}.`,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
    ].filter(Boolean).join("\n"));
  }

  private async handleResume(ctx: CommandContext, cmd: ParsedCommand) {
    const threadId = cmd.args[0];
    if (!threadId) {
      await this.reply(ctx, "Usage: `resume <number|codexThreadId|last> [prompt]`");
      return;
    }
    const selected = this.resolveRecentSession(ctx, threadId, false);
    const codexThreadId = threadId === "last" ? selected?.codexThreadId : selected?.codexThreadId ?? threadId;
    if (!codexThreadId) throw new Error(`No recent Codex session found for selector: ${threadId}`);

    const workspace = optionString(cmd, "cwd", "project", "workspace")
      ? this.workspaceFromCommandOrContext(ctx, cmd)
      : selected
        ? { cwd: selected.cwd, projectName: selected.projectName }
        : this.workspaceFromCommandOrContext(ctx, cmd);
    const threadContext = await this.ensureSlackThread(ctx, `Codex resumed: ${codexThreadId}`);
    const key = this.store.threadKey(threadContext.channelId, threadContext.threadTs);
    let binding = await this.codex.resumeThread({
      slackKey: key,
      channelId: threadContext.channelId,
      threadTs: threadContext.threadTs,
      codexThreadId,
      cwd: workspace.cwd,
      projectName: workspace.projectName,
      createdBy: ctx.userId
    });
    binding = this.store.updateThread(binding.key, { sendPolicy: DEFAULT_LINKED_SEND_POLICY });
    this.invalidateRecentSessions();

    const prompt = cmd.args.slice(1).join(" ").trim();
    if (prompt) {
      const { turnId, referencedSkills } = await this.codex.startTurn(binding, prompt);
      this.recordSessionCommand(ctx, binding, "send", prompt);
      const text = [
        `Resumed ${codeInline(codexThreadId)} and started turn ${codeInline(turnId)}.`,
        `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
        referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
      ].filter(Boolean).join("\n");
      await this.postThreadWithBlocks(ctx.client, binding.channelId, binding.threadTs, {
        text: `${text}\nChange send policy?`,
        blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), `${text}\nChange send policy?`)
      });
    } else {
      await this.postThreadWithBlocks(ctx.client, binding.channelId, binding.threadTs, {
        text: [
          `Resumed Codex thread ${codeInline(codexThreadId)} in ${codeInline(workspace.cwd)}.`,
          `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
          "Change send policy?"
        ].join("\n"),
        blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), [
          `Resumed Codex thread ${codeInline(codexThreadId)} in ${codeInline(workspace.cwd)}.`,
          `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
          "Change send policy?"
        ].join("\n"))
      });
    }
  }

  private async handleRerun(ctx: CommandContext, cmd: ParsedCommand) {
    if (cmd.args.length === 0) {
      await this.handleRerunPicker(ctx);
      return;
    }

    const selected = this.resolveOptionalRerunSelection(ctx, cmd);
    const binding = selected.binding;
    if (!binding?.codexThreadId) throw new Error("No Codex session to rerun. Use `new` first.");

    const explicitPrompt = selected.prompt;
    const prompt = explicitPrompt || binding.lastPrompt;
    if (!prompt) throw new Error("No previous prompt stored for rerun");
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;

    await this.executeBySendPolicy(
      ctx,
      cmd,
      {
        command: "rerun",
        prompt,
        selector: selected.selectorLabel
      },
      () => this.startRerun(ctx, binding, prompt, selected.selectorLabel)
    );
  }

  private async handleRerunSession(ctx: CommandContext, cmd: ParsedCommand) {
    const selector = cmd.args[0] ?? "last";
    if (!selector) {
      await this.reply(ctx, "Usage: `rerun-session <recent-number|codexThreadId|last> [prompt]`");
      return;
    }
    const binding = this.resolveRecentSession(ctx, selector);
    if (!binding?.codexThreadId) throw new Error(`No Codex session found for selector: ${selector}`);
    const prompt = cmd.args.slice(1).join(" ").trim() || binding.lastPrompt;
    if (!prompt) throw new Error("No previous prompt stored for selected session");
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;

    await this.executeBySendPolicy(
      ctx,
      cmd,
      {
        command: "rerun-session",
        prompt,
        selector
      },
      () => this.startRerun(ctx, binding, prompt, selector)
    );
  }

  private async startRerun(ctx: CommandContext, binding: SlackThreadBinding, prompt: string, selectorLabel?: string) {
    if (!binding.codexThreadId) throw new Error("No Codex session to rerun. Use `new` first.");
    const codexThreadId = binding.codexThreadId;
    const target = await this.materializeSessionBinding(ctx, binding);
    let resumed = await this.codex.resumeThread({
      slackKey: target.key,
      channelId: target.channelId,
      threadTs: target.threadTs,
      codexThreadId,
      cwd: target.cwd,
      projectName: target.projectName,
      createdBy: ctx.userId
    });
    this.invalidateRecentSessions();
    if (binding.key.startsWith("codex-cli:") || !binding.channelId) {
      resumed = this.store.updateThread(resumed.key, { sendPolicy: DEFAULT_LINKED_SEND_POLICY });
      this.invalidateRecentSessions();
    }
    const { turnId, referencedSkills } = await this.codex.startTurn(resumed, prompt);
    this.recordSessionCommand(ctx, resumed, "rerun", prompt);
    await this.postThread(ctx.client, target.channelId, target.threadTs, [
      `Rerun started as turn ${codeInline(turnId)}${selectorLabel ? ` from ${codeInline(selectorLabel)}` : ""}.`,
      `cwd: ${codeInline(target.cwd)}`,
      binding.lastFinalAnswer ? `previous last response: ${preview(binding.lastFinalAnswer, 500)}` : undefined,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
    ].filter(Boolean).join("\n"));
  }

  private async handleRerunPicker(ctx: CommandContext) {
    const candidates = this.rerunCandidates(ctx, 15);
    const language = this.currentLanguage(ctx);
    if (candidates.length === 0) {
      await this.reply(ctx, language === "ko" ? "재실행할 이전 prompt가 없습니다." : "No previous prompt is available to rerun.");
      return;
    }
    const text = renderRerunPicker(candidates, language);
    await this.replyWithBlocks(ctx, {
      text,
      blocks: rerunPickerBlocks(candidates, language, text)
    });
  }

  private rerunCandidates(ctx: CommandContext, limit: number): SlackThreadBinding[] {
    const candidates: SlackThreadBinding[] = [];
    const seen = new Set<string>();
    const add = (session: SlackThreadBinding | undefined) => {
      if (!session?.codexThreadId || !session.lastPrompt) return;
      const key = session.codexThreadId;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(session);
    };

    add(this.currentThreadBinding(ctx));
    add(this.store.findLatestForChannel(ctx.channelId));
    for (const session of this.listRecentSessions(50)) add(session);
    return candidates.slice(0, limit);
  }

  private async showRerunSelection(ctx: CommandContext, selector: string) {
    const binding = this.resolveRecentSession(ctx, selector);
    if (!binding?.codexThreadId || !binding.lastPrompt) throw new Error(`No rerunnable prompt found for selector: ${selector}`);
    const language = this.currentLanguage(ctx);
    const text = renderRerunSelection(binding, language);
    await this.replyWithBlocks(ctx, {
      text,
      blocks: rerunSelectionBlocks(binding, language, text)
    });
  }

  private async handleRerunAction(ctx: CommandContext, selector: string, action: string) {
    const binding = this.resolveRecentSession(ctx, selector);
    if (!binding?.codexThreadId || !binding.lastPrompt) throw new Error(`No rerunnable prompt found for selector: ${selector}`);
    const prompt = binding.lastPrompt;

    if (action === "run") {
      if (await this.replyIfUnknownSkills(ctx, prompt)) return;
      await this.startRerun(ctx, binding, prompt, selector);
      return;
    }

    if (action === "queue") {
      if (await this.replyIfUnknownSkills(ctx, prompt)) return;
      await this.enqueuePending(ctx, {
        command: "rerun",
        prompt,
        selector: binding.codexThreadId
      });
      return;
    }

    if (action === "full-preview") {
      await this.reply(ctx, renderRerunFullPreview(binding, this.currentLanguage(ctx)));
      return;
    }

    if (action === "cancel") {
      await this.reply(ctx, this.currentLanguage(ctx) === "ko" ? "재실행을 취소했습니다." : "Rerun cancelled.");
      return;
    }

    await this.reply(ctx, `Unknown rerun action: ${action}`);
  }

  private async handleSessions(ctx: CommandContext, cmd: ParsedCommand) {
    const recent = this.listRecentSessions(15);
    if (recent.length === 0) {
      await this.reply(ctx, "No Codex sessions found.");
      return;
    }
    const newChannelName = optionString(cmd, "channel");
    if (newChannelName) {
      await this.createChannelFromRecent(ctx, cmd, newChannelName, recent);
      return;
    }
    const lines = recent.map((s, index) => {
      return renderRecentSession(s, index);
    });
    const language = this.currentLanguage(ctx);
    await this.reply(ctx, [
      language === "ko" ? "최근 세션:" : "Recent sessions:",
      ...lines,
      "",
      language === "ko" ? "재실행: `rerun-session <number|codexThreadId|last> [prompt]`" : "Rerun: `rerun-session <number|codexThreadId|last> [prompt]`"
    ].join("\n"));
  }

  private async handleActiveSessions(ctx: CommandContext, cmd: ParsedCommand) {
    const active = this.listRecentSessions(50).filter((session) => session.status === "active" && session.key.startsWith("codex-cli:"));
    if (active.length === 0) {
      await this.reply(ctx, this.currentLanguage(ctx) === "ko" ? "실행 중인 Codex CLI 세션이 없습니다." : "No active Codex CLI sessions found.");
      return;
    }
    const newChannelName = optionString(cmd, "channel");
    if (newChannelName) {
      await this.createChannelFromRecent(ctx, cmd, newChannelName, active);
      return;
    }
    const language = this.currentLanguage(ctx);
    await this.reply(ctx, [
      language === "ko" ? "실행 중인 세션:" : "Active sessions:",
      ...active.slice(0, 15).map((session, index) => renderRecentSession(session, index)),
      "",
      language === "ko"
        ? "채널 연결: `active --channel <name> <number>`"
        : "Create/link channel: `active --channel <name> <number>`"
    ].join("\n"));
  }

  private async handleHistory(ctx: CommandContext, cmd: ParsedCommand) {
    const selector = cmd.args[0];
    const binding = selector
      ? this.resolveRecentSession(ctx, selector, false)
      : this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId) ?? this.resolveRecentSession(ctx, "last", false);
    if (!binding?.codexThreadId) throw new Error("No session found. Use `recent` first.");
    const history = this.sessionCommandHistory(binding);
    const language = this.currentLanguage(ctx);
    if (history.length === 0) {
      await this.reply(ctx, language === "ko" ? "이 세션에 기록된 명령이 없습니다." : "No recorded commands for this session.");
      return;
    }
    await this.reply(ctx, [
      language === "ko" ? `세션 명령 이력: ${codeInline(binding.codexThreadId)}` : `Session command history: ${codeInline(binding.codexThreadId)}`,
      ...history.map((item, index) => renderSessionCommand(item, index)),
      "",
      language === "ko"
        ? "재실행: `rerun-command [-f] <command-number> [session]`"
        : "Rerun: `rerun-command [-f] <command-number> [session]`"
    ].join("\n"));
  }

  private async handleRerunCommand(ctx: CommandContext, cmd: ParsedCommand) {
    const commandSelector = cmd.args[0];
    if (!commandSelector) {
      await this.reply(ctx, "Usage: `rerun-command [-f|--force] <command-number> [session]`");
      return;
    }
    const sessionSelector = cmd.args[1];
    const binding = sessionSelector
      ? this.resolveRecentSession(ctx, sessionSelector, false)
      : this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId) ?? this.resolveRecentSession(ctx, "last", false);
    if (!binding?.codexThreadId) throw new Error("No session found. Use `recent` first.");
    const history = this.sessionCommandHistory(binding);
    const selected = /^\d+$/.test(commandSelector) ? history[Number(commandSelector) - 1] : undefined;
    if (!selected) throw new Error(`No command found for selector: ${commandSelector}`);
    if (await this.replyIfUnknownSkills(ctx, selected.prompt)) return;

    await this.executeBySendPolicy(
      ctx,
      cmd,
      {
        command: "rerun-command",
        prompt: selected.prompt,
        selector: sessionSelector ?? binding.codexThreadId
      },
      () => this.startRerun(ctx, binding, selected.prompt, `${sessionSelector ?? "current"}:${commandSelector}`)
    );
  }

  private async handleStatus(ctx: CommandContext) {
    const binding = this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
    if (!binding) {
      await this.reply(ctx, "No session bound here.");
      return;
    }
    await this.reply(ctx, [
      `codexThreadId: ${codeInline(binding.codexThreadId ?? "none")}`,
      `status: ${codeInline(binding.status)}`,
      `cwd: ${codeInline(binding.cwd)}`,
      `sendMode: ${codeInline(this.sendModeForContext(ctx) ? "on" : "off")}`,
      `sendPolicy: ${codeInline(this.sendPolicyForContext(ctx))}`,
      binding.activeTurnId ? `activeTurnId: ${codeInline(binding.activeTurnId)}` : undefined,
      binding.lastPrompt ? `lastPrompt: ${binding.lastPrompt.slice(0, 300)}` : undefined,
      binding.lastFinalAnswer ? `lastFinalAnswer:\n${binding.lastFinalAnswer.slice(0, 1000)}` : undefined
    ].filter(Boolean).join("\n"));
  }

  private async handleStop(ctx: CommandContext) {
    const binding = this.requireCurrentBinding(ctx);
    await this.codex.interrupt(binding);
    await this.reply(ctx, "Interrupt requested.");
  }

  private async handlePending(ctx: CommandContext) {
    const pending = this.store.listPendingCommands(this.pendingScopeKey(ctx));
    if (pending.length === 0) {
      await this.reply(ctx, this.currentLanguage(ctx) === "ko" ? "대기 중인 명령이 없습니다." : "No pending commands.");
      return;
    }
    await this.reply(ctx, renderPendingCommands(pending, this.currentLanguage(ctx)));
  }

  private async handlePendingEdit(ctx: CommandContext, cmd: ParsedCommand) {
    const selector = cmd.args[0];
    const prompt = cmd.args.slice(1).join(" ").trim();
    if (!selector || !prompt) {
      await this.reply(ctx, "Usage: `pending-edit <number|id> <new prompt>`");
      return;
    }
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;
    const pending = this.resolvePending(ctx, selector);
    this.store.updatePendingCommand(pending.id, { prompt });
    await this.reply(ctx, `Pending command ${codeInline(selector)} updated.`);
  }

  private async handlePendingDrop(ctx: CommandContext, cmd: ParsedCommand) {
    const selector = cmd.args[0];
    if (!selector) {
      await this.reply(ctx, "Usage: `pending-drop <number|id>`");
      return;
    }
    const pending = this.resolvePending(ctx, selector);
    this.store.removePendingCommand(pending.id);
    await this.reply(ctx, `Dropped pending command ${codeInline(selector)}.`);
  }

  private async handlePendingRun(ctx: CommandContext, cmd: ParsedCommand) {
    const selector = cmd.args[0] ?? "1";
    if (selector === "all") {
      const pending = [...this.store.listPendingCommands(this.pendingScopeKey(ctx))];
      if (pending.length === 0) {
        await this.reply(ctx, "No pending commands.");
        return;
      }
      for (const item of pending) {
        await this.runPendingCommand(ctx, item);
        this.store.removePendingCommand(item.id);
      }
      return;
    }
    const pending = this.resolvePending(ctx, selector);
    await this.runPendingCommand(ctx, pending);
    this.store.removePendingCommand(pending.id);
  }

  private async runPendingCommand(ctx: CommandContext, pending: PendingCommand) {
    if (pending.command === "new") {
      if (!pending.prompt || !pending.cwd) throw new Error("Pending new command is missing prompt or cwd");
      await this.startNewTurn(ctx, { cwd: pending.cwd, projectName: pending.projectName }, pending.prompt);
      return;
    }
    if (pending.command === "send") {
      if (!pending.prompt) throw new Error("Pending send command is missing prompt");
      await this.startSend(ctx, pending.prompt);
      return;
    }
    if (pending.command === "rerun" || pending.command === "rerun-session" || pending.command === "rerun-command") {
      const binding = pending.selector ? this.resolveRecentSession(ctx, pending.selector) : this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
      if (!binding?.codexThreadId) throw new Error("No Codex session to rerun");
      const prompt = pending.prompt || binding.lastPrompt;
      if (!prompt) throw new Error("Pending rerun command is missing prompt");
      await this.startRerun(ctx, binding, prompt, pending.selector);
      return;
    }
  }

  private async handlePendingAction(ctx: CommandContext, pendingId: string, action: string) {
    const pending = this.store.getPendingCommand(pendingId);
    if (!pending) {
      await this.reply(ctx, "Pending command was already handled or removed.");
      return;
    }

    if (action === "run") {
      await this.runPendingCommand(ctx, pending);
      this.store.removePendingCommand(pending.id);
      await this.reply(ctx, `Ran pending command ${codeInline(pending.id)}.`);
      return;
    }

    if (action === "queue") {
      const index = this.store.listPendingCommands(pending.scopeKey).findIndex((item) => item.id === pending.id) + 1;
      await this.reply(ctx, [
        `Kept pending command ${codeInline(pending.id)} in the queue.`,
        index > 0 ? `Run later: ${codeInline(`pending-run ${index}`)}` : undefined,
        index > 0 ? `Edit: ${codeInline(`pending-edit ${index} <new prompt>`)}` : undefined
      ].filter(Boolean).join("\n"));
      return;
    }

    if (action === "cancel") {
      this.store.removePendingCommand(pending.id);
      await this.reply(ctx, `Cancelled pending command ${codeInline(pending.id)}.`);
      return;
    }

    await this.reply(ctx, `Unknown pending action: ${action}`);
  }

  private async executeBySendPolicy(
    ctx: CommandContext,
    cmd: ParsedCommand,
    pending: Omit<PendingCommand, "id" | "scopeKey" | "channelId" | "threadTs" | "createdAt" | "updatedAt" | "createdBy">,
    runNow: () => Promise<void>
  ) {
    if (isForce(cmd)) {
      await runNow();
      return;
    }

    const policy = this.sendPolicyForContext(ctx);
    if (policy === "immediate") {
      await runNow();
      return;
    }
    if (policy === "confirm") {
      await this.confirmPending(ctx, pending);
      return;
    }
    await this.enqueuePending(ctx, pending);
  }

  private async confirmPending(ctx: CommandContext, pending: Omit<PendingCommand, "id" | "scopeKey" | "channelId" | "threadTs" | "createdAt" | "updatedAt" | "createdBy">) {
    const saved = this.store.addPendingCommand({
      ...pending,
      scopeKey: this.pendingScopeKey(ctx),
      channelId: ctx.channelId,
      threadTs: ctx.threadTs,
      createdBy: ctx.userId
    });
    const language = this.currentLanguage(ctx);
    const text = renderPendingConfirmation(saved, language);
    await this.replyWithBlocks(ctx, {
      text,
      blocks: pendingConfirmationBlocks(saved, language, text)
    });
  }

  private async enqueuePending(ctx: CommandContext, pending: Omit<PendingCommand, "id" | "scopeKey" | "channelId" | "threadTs" | "createdAt" | "updatedAt" | "createdBy">) {
    const saved = this.store.addPendingCommand({
      ...pending,
      scopeKey: this.pendingScopeKey(ctx),
      channelId: ctx.channelId,
      threadTs: ctx.threadTs,
      createdBy: ctx.userId
    });
    await this.reply(ctx, [
      `Queued pending command ${codeInline(saved.id)}.`,
      `Run: ${codeInline(`pending-run ${this.store.listPendingCommands(saved.scopeKey).length}`)}`,
      `Edit: ${codeInline(`pending-edit ${this.store.listPendingCommands(saved.scopeKey).length} <new prompt>`)}`,
      `Force immediate execution next time with ${codeInline("-f")} or ${codeInline("--force")}.`
    ].join("\n"));
  }

  private recordSessionCommand(ctx: CommandContext, binding: SlackThreadBinding, command: PendingCommand["command"], prompt: string) {
    this.store.addSessionCommand({
      slackKey: binding.key,
      channelId: binding.channelId,
      threadTs: binding.threadTs,
      codexThreadId: binding.codexThreadId,
      command,
      prompt,
      cwd: binding.cwd,
      projectName: binding.projectName,
      createdBy: ctx.userId
    });
    this.invalidateRecentSessions();
  }

  private sessionCommandHistory(binding: SlackThreadBinding): Array<SessionCommandRecord | CodexCliSessionCommand> {
    const stored = this.store.listSessionCommands(binding);
    if (stored.length > 0) return stored;
    return binding.sessionCommands ?? (binding.lastPrompt ? [{ timestamp: binding.updatedAt, prompt: binding.lastPrompt }] : []);
  }

  private resolvePending(ctx: CommandContext, selector: string): PendingCommand {
    const pending = this.store.listPendingCommands(this.pendingScopeKey(ctx));
    if (/^\d+$/.test(selector)) {
      const selected = pending[Number(selector) - 1];
      if (selected) return selected;
    }
    const selected = pending.find((p) => p.id === selector || p.id.startsWith(selector));
    if (!selected) throw new Error(`No pending command found for selector: ${selector}`);
    return selected;
  }

  private pendingScopeKey(ctx: CommandContext): string {
    return ctx.threadTs ? this.store.threadKey(ctx.channelId, ctx.threadTs) : `channel:${ctx.channelId}`;
  }

  private async handleLanguage(ctx: CommandContext, cmd: ParsedCommand) {
    const requested = normalizeLanguage(cmd.args[0]);
    if (!requested) {
      await this.reply(ctx, this.currentLanguage(ctx) === "ko" ? "사용법: `language en|ko`" : "Usage: `language en|ko`");
      return;
    }

    const now = new Date().toISOString();
    if (ctx.threadTs) {
      const key = this.store.threadKey(ctx.channelId, ctx.threadTs);
      const existing = this.store.getThreadBinding(key);
      if (existing) {
        this.store.updateThread(key, { language: requested });
      } else {
        const workspace = this.currentWorkspace(ctx);
        this.store.upsertThreadBinding({
          key,
          channelId: ctx.channelId,
          threadTs: ctx.threadTs,
          cwd: workspace.cwd,
          projectName: workspace.projectName,
          status: "idle",
          sendMode: this.sendModeForContext(ctx),
          sendPolicy: this.sendPolicyForContext(ctx),
          language: requested,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId
        });
      }
    } else {
      const existing = this.store.getChannelBinding(ctx.channelId);
      const workspace = this.currentWorkspace(ctx);
      this.store.setChannelBinding({
        channelId: ctx.channelId,
        cwd: existing?.cwd ?? workspace.cwd,
        projectName: existing?.projectName ?? workspace.projectName,
        language: requested,
        updatedAt: now,
        updatedBy: ctx.userId
      });
    }

    await this.reply(ctx, requested === "ko" ? "언어를 한국어로 변경했습니다." : "Language changed to English.");
  }

  private currentWorkspace(ctx: CommandContext): ResolvedWorkspace {
    const binding = this.currentThreadBinding(ctx);
    if (binding) return { cwd: binding.cwd, projectName: binding.projectName };
    const storedChannel = this.store.getChannelBinding(ctx.channelId);
    if (storedChannel) return { cwd: storedChannel.cwd, projectName: storedChannel.projectName };
    const configChannel = this.paths.resolveProjectForChannel(ctx.channelId);
    if (configChannel) return configChannel;
    return { cwd: this.navigationRoot() };
  }

  private currentLanguage(ctx: CommandContext): LanguageCode {
    const binding = this.currentThreadBinding(ctx);
    if (binding?.language) return binding.language;
    const storedChannel = this.store.getChannelBinding(ctx.channelId);
    return storedChannel?.language ?? "en";
  }

  private sendModeForContext(ctx: CommandContext): boolean {
    return this.isSendModeEnabled(ctx.channelId, ctx.threadTs);
  }

  private isSendModeEnabled(channelId: string, threadTs?: string): boolean {
    if (threadTs) {
      const binding = this.store.getThreadBinding(this.store.threadKey(channelId, threadTs));
      if (binding?.sendMode !== undefined) return binding.sendMode;
    }
    const storedChannel = this.store.getChannelBinding(channelId);
    if (storedChannel?.sendMode !== undefined) return storedChannel.sendMode;
    return true;
  }

  private sendPolicyForContext(ctx: CommandContext): SendPolicy {
    if (ctx.threadTs) {
      const binding = this.store.getThreadBinding(this.store.threadKey(ctx.channelId, ctx.threadTs));
      if (binding?.sendPolicy) return binding.sendPolicy;
    }
    const storedChannel = this.store.getChannelBinding(ctx.channelId);
    return storedChannel?.sendPolicy ?? "immediate";
  }

  private workspaceFromCommandOrContext(ctx: CommandContext, cmd: ParsedCommand): ResolvedWorkspace {
    const option = optionString(cmd, "cwd", "project", "workspace");
    if (option) return this.paths.resolve(option, this.currentWorkspace(ctx).cwd);

    // Convenience: `new api fix tests` treats the first arg as a workspace only
    // when it is a configured project name. Arbitrary paths should use --cwd.
    if (cmd.name === "new" && cmd.args.length >= 2) {
      const first = cmd.args[0];
      if (this.config.projects.has(first)) {
        return this.paths.resolve(first, this.currentWorkspace(ctx).cwd);
      }
    }
    return this.currentWorkspace(ctx);
  }

  private promptFrom(cmd: ParsedCommand, opts: { allowProjectFirstArg?: boolean } = {}): string {
    if (!opts.allowProjectFirstArg) return cmd.rawArgs.trim();
    const option = optionString(cmd, "cwd", "project", "workspace");
    if (option) return cmd.args.join(" ").trim();
    if (cmd.args.length >= 2) {
      const first = cmd.args[0];
      if (this.config.projects.has(first)) return cmd.args.slice(1).join(" ").trim();
    }
    return cmd.rawArgs.trim();
  }

  private currentThreadBinding(ctx: CommandContext): SlackThreadBinding | undefined {
    if (!ctx.threadTs) return undefined;
    return this.store.getThreadBinding(this.store.threadKey(ctx.channelId, ctx.threadTs));
  }

  private requireCurrentBinding(ctx: CommandContext): SlackThreadBinding {
    const binding = this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
    if (!binding?.codexThreadId) throw new Error("No Codex session bound here. Use `new` or `resume` first.");
    return binding;
  }

  private resolveOptionalRerunSelection(ctx: CommandContext, cmd: ParsedCommand): { binding?: SlackThreadBinding; prompt: string; selectorLabel?: string } {
    const first = cmd.args[0];
    if (first) {
      const selected = this.resolveRecentSession(ctx, first, false);
      if (selected) {
        return {
          binding: selected,
          prompt: cmd.args.slice(1).join(" ").trim(),
          selectorLabel: first
        };
      }
    }
    return {
      binding: this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId),
      prompt: cmd.rawArgs.trim()
    };
  }

  private resolveRecentSession(ctx: CommandContext, selector: string, throwOnMissing = true): SlackThreadBinding | undefined {
    const recent = this.listRecentSessions(50);
    let binding: SlackThreadBinding | undefined;

    if (selector === "last") {
      binding = this.store.findLatestForChannel(ctx.channelId) ?? recent[0];
    } else if (/^\d+$/.test(selector)) {
      binding = recent[Number(selector) - 1];
    } else {
      binding = recent.find((s) => s.codexThreadId === selector || s.codexThreadId?.startsWith(selector));
    }

    if (!binding && throwOnMissing) {
      throw new Error(`No recent Codex session found for selector: ${selector}`);
    }
    return binding;
  }

  private listRecentSessions(limit: number): SlackThreadBinding[] {
    const now = Date.now();
    const cached = this.recentSessionsCache;
    if (cached && cached.expiresAt > now && cached.limit >= limit) {
      return cached.sessions.slice(0, limit);
    }

    const scanLimit = Math.max(limit, cached?.limit ?? 0);
    const local = this.store.listThreads(scanLimit).filter((session) => session.codexThreadId);
    const seen = new Set(local.map((session) => session.codexThreadId).filter(Boolean));
    let external: SlackThreadBinding[] = [];
    try {
      external = listCodexCliSessions({ sessionsDir: env.codexSessionsDir, limit: scanLimit })
        .filter((session) => !seen.has(session.id))
        .map((session) => ({
          key: `codex-cli:${session.id}`,
          channelId: "",
          threadTs: "",
          cwd: session.cwd,
          codexThreadId: session.id,
          status: session.status,
          lastPrompt: session.lastPrompt,
          lastFinalAnswer: session.lastFinalAnswer,
          sessionCommands: session.commands,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          createdBy: "codex-cli"
        }));
    } catch (error) {
      logger.warn("failed to read Codex CLI sessions", { sessionsDir: env.codexSessionsDir, error: String(error) });
    }
    const sessions = [...local, ...external]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, scanLimit);
    this.recentSessionsCache = { expiresAt: now + RECENT_SESSIONS_CACHE_MS, limit: scanLimit, sessions };
    return sessions.slice(0, limit);
  }

  private invalidateRecentSessions() {
    this.recentSessionsCache = undefined;
  }

  private async materializeSessionBinding(ctx: CommandContext, binding: SlackThreadBinding): Promise<SlackThreadBinding> {
    if (binding.channelId && binding.threadTs && !binding.key.startsWith("codex-cli:")) return binding;
    const threadContext = await this.ensureSlackThread(ctx, `Codex resumed: ${binding.codexThreadId}`);
    return {
      ...binding,
      key: this.store.threadKey(threadContext.channelId, threadContext.threadTs),
      channelId: threadContext.channelId,
      threadTs: threadContext.threadTs,
      createdBy: ctx.userId
    };
  }

  private async createChannelFromRecent(ctx: CommandContext, cmd: ParsedCommand, channelNameRaw: string, recent: SlackThreadBinding[]) {
    const selector = cmd.args[0] ?? "1";
    const session = /^\d+$/.test(selector)
      ? recent[Number(selector) - 1]
      : recent.find((s) => s.codexThreadId === selector || s.codexThreadId?.startsWith(selector));
    if (!session?.codexThreadId) throw new Error(`No recent Codex session found for selector: ${selector}`);

    const channelName = normalizeSlackChannelName(channelNameRaw);
    const channelId = await this.createOrReuseSlackChannel(ctx.client, channelName);
    this.store.setChannelBinding({
      channelId,
      cwd: session.cwd,
      projectName: session.projectName,
      sendPolicy: DEFAULT_LINKED_SEND_POLICY,
      language: this.currentLanguage(ctx),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId
    });
    this.invalidateRecentSessions();
    const linkedText = [
        `Channel linked from recent session ${codeInline(session.codexThreadId)}.`,
        `cwd: ${codeInline(session.cwd)}`,
        session.lastFinalAnswer ? `last response: ${preview(session.lastFinalAnswer, 500)}` : undefined,
        `Send policy was set to ${codeInline(DEFAULT_LINKED_SEND_POLICY)} for safety. Change it?`
      ].filter(Boolean).join("\n");
    const posted = await this.chatPostMessage(ctx.client, {
      channel: channelId,
      text: linkedText,
      blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), linkedText)
    });
    if (posted.ts) {
      const key = this.store.threadKey(channelId, posted.ts);
      this.store.upsertThreadBinding({
        key,
        channelId,
        threadTs: posted.ts,
        cwd: session.cwd,
        projectName: session.projectName,
        codexThreadId: session.codexThreadId,
        status: session.status,
        lastPrompt: session.lastPrompt,
        lastFinalAnswer: session.lastFinalAnswer,
        sessionCommands: session.sessionCommands,
        title: session.title,
        sendPolicy: DEFAULT_LINKED_SEND_POLICY,
        language: this.currentLanguage(ctx),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: ctx.userId
      });
      this.invalidateRecentSessions();
    }
    await this.reply(ctx, [
      `Created or reused ${codeInline(`#${channelName}`)} and linked it to ${codeInline(session.cwd)}.`,
      `Default send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}.`
    ].join("\n"));
  }

  private async bindSessionToHere(ctx: CommandContext, session: SlackThreadBinding) {
    if (!session.codexThreadId) throw new Error("Selected session has no Codex session ID.");
    const threadContext = await this.ensureSlackThread(ctx, `Codex session bound: ${session.codexThreadId}`);
    const key = this.store.threadKey(threadContext.channelId, threadContext.threadTs);
    const now = new Date().toISOString();
    this.store.upsertThreadBinding({
      key,
      channelId: threadContext.channelId,
      threadTs: threadContext.threadTs,
      cwd: session.cwd,
      projectName: session.projectName,
      codexThreadId: session.codexThreadId,
      status: session.status,
      lastPrompt: session.lastPrompt,
      lastFinalAnswer: session.lastFinalAnswer,
      sessionCommands: session.sessionCommands,
      title: session.title,
      sendMode: this.sendModeForContext(ctx),
      sendPolicy: DEFAULT_LINKED_SEND_POLICY,
      language: this.currentLanguage(ctx),
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId
    });
    this.store.setChannelBinding({
      channelId: threadContext.channelId,
      cwd: session.cwd,
      projectName: session.projectName,
      sendPolicy: DEFAULT_LINKED_SEND_POLICY,
      language: this.currentLanguage(ctx),
      updatedAt: now,
      updatedBy: ctx.userId
    });
    this.invalidateRecentSessions();

    const text = [
      `Bound this ${ctx.threadTs ? "thread" : "channel"} to Codex session ${codeInline(session.codexThreadId)}.`,
      `cwd: ${codeInline(session.cwd)}`,
      `send policy: ${codeInline(DEFAULT_LINKED_SEND_POLICY)}`,
      this.sendModeForContext(ctx)
        ? "Send mode is on: normal channel messages, `send`, `$skill ...`, and prefixed messages continue this session."
        : "Send mode is off: use `send <prompt>`, `$skill ...`, or the configured prefix to continue this session.",
      "Messages starting with `/` stay Slack bot commands.",
      "Change send policy?"
    ].join("\n");
    await this.postThreadWithBlocks(ctx.client, threadContext.channelId, threadContext.threadTs, {
      text,
      blocks: sendPolicyChoiceBlocks(this.currentLanguage(ctx), text)
    });
  }

  private fixChannelWorkspace(ctx: CommandContext, workspace: ResolvedWorkspace) {
    this.store.setChannelBinding({
      channelId: ctx.channelId,
      cwd: workspace.cwd,
      projectName: workspace.projectName,
      language: this.currentLanguage(ctx),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId
    });
  }

  private navigationRoot(): string {
    return resolveUserPath(env.navigationRoot);
  }

  private isChannelCreationShortcut(ctx: CommandContext, parsed: ParsedCommand): boolean {
    if (!ctx.isSlash || parsed.name !== "send" || !parsed.implicitSend) return false;
    const raw = parsed.rawArgs.trim();
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,78}$/.test(raw);
  }

  private async createOrReuseSlackChannel(client: WebClient, rawName: string): Promise<string> {
    const name = normalizeSlackChannelName(rawName);
    if (!name) throw new Error("Channel name is empty after normalization");
    const existing = await findSlackChannel(client, name);
    let channelId = existing?.id;
    if (!channelId) {
      const created = await client.conversations.create({ name, is_private: env.createPrivateChannels });
      channelId = created.channel?.id;
    }
    if (!channelId) throw new Error(`Slack did not return channel id for #${name}`);
    if (env.defaultInviteUserIds.length > 0) {
      try {
        await client.conversations.invite({ channel: channelId, users: env.defaultInviteUserIds.join(",") });
      } catch (error) {
        logger.warn("invite failed; continuing", { channelName: name, error: String(error) });
      }
    }
    return channelId;
  }

  private async ensureSlackThread(ctx: CommandContext, rootText: string): Promise<{ channelId: string; threadTs: string }> {
    if (ctx.threadTs) return { channelId: ctx.channelId, threadTs: ctx.threadTs };
    const posted = await this.chatPostMessage(ctx.client, {
      channel: ctx.channelId,
      text: rootText
    });
    if (!posted.ts) throw new Error("Slack did not return message ts");
    return { channelId: ctx.channelId, threadTs: posted.ts };
  }

  private async onTurnCompleted(event: TurnCompletedEvent) {
    const statusLine = event.status === "completed" ? "Codex final answer" : `Codex ${event.status}`;
    const text = [`*${statusLine}*`, `thread: ${codeInline(event.codexThreadId)}`, event.errorMessage ? `error: ${event.errorMessage}` : undefined, "", event.finalAnswer]
      .filter((v) => v !== undefined)
      .join("\n");
    await this.postThread(this.app.client, event.channelId, event.threadTs, text);
  }

  private async reply(ctx: CommandContext, text: string) {
    if (ctx.preferRespond && ctx.respond) {
      if (await this.tryRespond(ctx, { response_type: "ephemeral", replace_original: false, text })) return;
    }
    if (ctx.isSlash && ctx.respond) {
      await ctx.respond({ response_type: "ephemeral", text });
      return;
    }
    if (ctx.threadTs) {
      await this.postThread(ctx, ctx.channelId, ctx.threadTs, text);
    } else {
      await this.postThread(ctx, ctx.channelId, undefined, text);
    }
  }

  private async replyWithBlocks(ctx: CommandContext, message: { text: string; blocks?: any[] }) {
    if (ctx.preferRespond && ctx.respond) {
      if (await this.tryRespond(ctx, { response_type: "ephemeral", replace_original: false, text: message.text, blocks: message.blocks })) return;
    }
    if (ctx.isSlash && ctx.respond) {
      await ctx.respond({ response_type: "ephemeral", text: message.text, blocks: message.blocks });
      return;
    }
    if (ctx.threadTs) {
      await this.chatPostMessage(ctx.client, { channel: ctx.channelId, thread_ts: ctx.threadTs, text: message.text, blocks: message.blocks });
    } else {
      await this.chatPostMessage(ctx.client, { channel: ctx.channelId, text: message.text, blocks: message.blocks });
    }
  }

  private async tryRespond(ctx: CommandContext, message: any): Promise<boolean> {
    if (!ctx.respond) return false;
    try {
      await ctx.respond(message);
      return true;
    } catch (error) {
      logger.warn("Slack action respond failed; falling back to chat.postMessage", errorDetails(error));
      return false;
    }
  }

  private async postThread(clientOrCtx: WebClient | CommandContext, channel: string, threadTs: string | undefined, text: string) {
    const client = "client" in clientOrCtx ? clientOrCtx.client : clientOrCtx;
    const chunks = splitForSlack(text, env.slackMaxMessageChars);
    for (const chunk of chunks) {
      await this.chatPostMessage(client, { channel, thread_ts: threadTs, text: chunk });
    }
  }

  private async postThreadWithBlocks(client: WebClient, channel: string, threadTs: string | undefined, message: { text: string; blocks?: any[] }) {
    await this.chatPostMessage(client, { channel, thread_ts: threadTs, text: message.text, blocks: message.blocks });
  }

  private async chatPostMessage(client: WebClient, params: Parameters<WebClient["chat"]["postMessage"]>[0]) {
    try {
      return await client.chat.postMessage(params);
    } catch (error) {
      if (!isSlackApiError(error, "not_in_channel") || typeof params.channel !== "string") throw error;
      await this.joinChannelForPost(client, params.channel);
      return await client.chat.postMessage(params);
    }
  }

  private async joinChannelForPost(client: WebClient, channelId: string) {
    if (!channelId.startsWith("C")) {
      throw new Error(`The bot is not in ${channelId}. Invite the app to this private channel, then run the command again.`);
    }
    try {
      await client.conversations.join({ channel: channelId });
      logger.info("joined Slack channel before posting", { channelId });
    } catch (error) {
      throw new Error(`Could not join ${channelId}. Invite the app to the channel, then run the command again. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private commandAssistMessage(query: string, language: LanguageCode, suggestions = commandSuggestions(query, 10)): { text: string; blocks: any[] } {
    return {
      text: renderCommandSuggestions(query, language, env.commandPrefix, suggestions),
      blocks: commandPickerBlocks(language, query, suggestions)
    };
  }

  private skillAssistMessage(filter: string, rawText: string, token = `$${filter.replace(/^\$/, "")}`, leadText?: string): { text: string; blocks: any[] } {
    const normalized = filter.replace(/^\$/, "").trim();
    const matchingSkills = normalized ? this.skills.search(normalized) : this.skills.list();
    const pickerSkills = matchingSkills.length > 0 || !normalized
      ? matchingSkills
      : this.skills.suggestionsFor(normalized, 100);
    const isSuggested = Boolean(normalized && matchingSkills.length === 0 && pickerSkills.length > 0);
    const text = [leadText, this.renderSkills(normalized, pickerSkills, isSuggested)].filter(Boolean).join("\n\n");
    return {
      text,
      blocks: skillPickerBlocks(pickerSkills.slice(0, MAX_SKILL_PICKER_OPTIONS), normalized, rawText, token, text)
    };
  }

  private async handleAssistAction(body: any, client: WebClient, respond?: (message: any) => Promise<any>) {
    const action = body.actions?.[0];
    const rawValue = action?.selected_option?.value ?? action?.value;
    const value = parseAssistActionValue(rawValue);
    const ctx = this.contextFromAction(body, client, respond);

    try {
      if (!this.isAllowed(ctx.userId)) {
        await this.reply(ctx, "Not allowed.");
        return;
      }

      if (value.kind === "command" && value.command) {
        await this.handleCommandSelect(ctx, value.command);
        return;
      }

      if (value.kind === "skill" && value.rawText && value.token) {
        const selected = action?.selected_option?.value ? parseAssistActionValue(action.selected_option.value) : value;
        const skillName = selected.command;
        if (!skillName) {
          await this.reply(ctx, "No skill selected.");
          return;
        }
        const nextRawText = replaceSkillToken(value.rawText, value.token, `$${skillName}`);
        await this.handleCommand({ ...ctx, rawText: nextRawText });
        return;
      }

      if (value.kind === "bind-session" && value.sessionId) {
        const session = this.resolveRecentSession(ctx, value.sessionId);
        if (!session) throw new Error(`No recent Codex session found for selector: ${value.sessionId}`);
        await this.bindSessionToHere(ctx, session);
        return;
      }

      if (value.kind === "session-action" && value.command) {
        await this.handleSessionAction(ctx, value.command);
        return;
      }

      if (value.kind === "pending-action" && value.pendingId && value.command) {
        await this.handlePendingAction(ctx, value.pendingId, value.command);
        return;
      }

      if (value.kind === "rerun-action" && value.sessionId && value.command) {
        if (value.command === "select") {
          await this.showRerunSelection(ctx, value.sessionId);
        } else {
          await this.handleRerunAction(ctx, value.sessionId, value.command);
        }
        return;
      }
    } catch (error) {
      logger.error("assist action failed", { kind: value.kind, ...errorDetails(error) });
      await this.reply(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleCommandSelect(ctx: CommandContext, command: string) {
    const entry = COMMAND_HELP.find((item) => item.name === command || item.aliases?.includes(command));
    if (!entry) {
      await this.reply(ctx, `Unknown command: ${command}`);
      return;
    }
    if (DIRECT_RUN_COMMANDS.has(entry.name)) {
      await this.handleCommand({ ...ctx, rawText: entry.name });
      return;
    }

    const language = this.currentLanguage(ctx);
    const text = language === "ko"
      ? [`선택한 명령어: ${codeInline(entry.name)}`, `형식: ${codeInline(entry.usage)}`, entry.ko, "", `예: ${codeInline(`${env.commandPrefix} ${entry.usage}`)}`].join("\n")
      : [`Selected command: ${codeInline(entry.name)}`, `Usage: ${codeInline(entry.usage)}`, entry.en, "", `Example: ${codeInline(`${env.commandPrefix} ${entry.usage}`)}`].join("\n");
    await this.reply(ctx, text);
  }

  private contextFromAction(body: any, client: WebClient, respond?: (message: any) => Promise<any>): CommandContext {
    return {
      userId: body.user?.id,
      channelId: body.channel?.id ?? body.container?.channel_id,
      threadTs: body.message?.thread_ts ?? body.container?.thread_ts,
      messageTs: body.message?.ts ?? body.container?.message_ts,
      isSlash: false,
      rawText: "",
      preferRespond: true,
      client,
      respond
    };
  }

  private renderProjects(): string {
    const projects = [...this.config.projects.values()];
    if (projects.length === 0) return "No projects configured.";
    return projects
      .map((p) => `- ${codeInline(p.name)} → ${codeInline(p.absolutePath)}${p.slackChannelName ? ` (#${p.slackChannelName})` : ""}${p.default ? " default" : ""}`)
      .join("\n");
  }

  private renderSkills(filter = "", providedSkills?: SkillDef[], suggested = false): string {
    const normalized = filter.replace(/^\$/, "").trim();
    const skills = providedSkills ?? (normalized ? this.skills.search(normalized) : this.skills.list());
    if (skills.length === 0) {
      return normalized
        ? `No skills configured matching ${codeInline(`$${normalized}`)}. Use ${codeInline("$")} or ${codeInline("skills")} to list all skills.`
        : "No skills configured.";
    }
    const title = suggested
      ? `Skill suggestions for ${codeInline(`$${normalized}`)}:`
      : normalized ? `Skills matching ${codeInline(`$${normalized}`)}:` : "Configured skills:";
    const visible = skills.slice(0, 25);
    return [
      title,
      ...visible.map((skill) => `- ${codeInline(`$${skill.name}`)} -> ${codeInline(skill.absolutePath)}${skill.description ? ` - ${skill.description}` : ""}`),
      skills.length > visible.length ? `... ${skills.length - visible.length} more available in the picker` : undefined
    ].filter(Boolean).join("\n");
  }

  private isSkillLookupShortcut(parsed: ParsedCommand): boolean {
    return parsed.name === "send" && this.isSkillLookupText(parsed.rawArgs);
  }

  private isSkillLookupText(text: string): boolean {
    return /^\$[A-Za-z0-9_.-]*$/.test(text.trim());
  }

  private async replyIfUnknownSkills(ctx: CommandContext, prompt: string): Promise<boolean> {
    const completion = this.skillCompletionForPrompt(prompt);
    if (completion) {
      await this.replyWithBlocks(ctx, this.skillAssistMessage(completion.prefix, ctx.rawText, completion.token));
      return true;
    }

    if (!this.skills.isStrict()) return false;
    const unknown = this.skills.unknownSkillNames(prompt);
    if (unknown.length === 0) return false;
    const unknownSuggestions = new Map(unknown.map((name) => [name, this.skills.suggestionsFor(name)]));
    const lines = unknown.map((name) => {
      const suggestions = unknownSuggestions.get(name) ?? [];
      if (suggestions.length === 0) {
        return `Unknown skill ${codeInline(`$${name}`)}. Use ${codeInline("$")} or ${codeInline("skills")} to list configured skills.`;
      }
      return `Unknown skill ${codeInline(`$${name}`)}. Did you mean ${suggestions.map((skill) => codeInline(`$${skill.name}`)).join(", ")}?`;
    });
    const firstWithSuggestions = unknown.find((name) => (unknownSuggestions.get(name)?.length ?? 0) > 0);
    if (firstWithSuggestions) {
      await this.replyWithBlocks(ctx, this.skillAssistMessage(firstWithSuggestions, ctx.rawText, `$${firstWithSuggestions}`, lines.join("\n")));
      return true;
    }

    await this.reply(ctx, lines.join("\n"));
    return true;
  }

  private skillCompletionForPrompt(prompt: string): { prefix: string; token: string } | undefined {
    const tokenPattern = /(^|\s)(\$([A-Za-z0-9_.-]*))/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(prompt)) !== null) {
      const token = match[2];
      const prefix = match[3] ?? "";
      if (!prefix) return { prefix, token };
      if (this.config.skills.has(prefix)) continue;
      if (this.skills.search(prefix).length > 0) return { prefix, token };
    }
    return undefined;
  }
}

function codeInline(text: string): string {
  return `\`${String(text).replaceAll("`", "ʼ")}\``;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const withResponse = error as Error & { response?: { status?: number; statusText?: string; data?: unknown }; data?: unknown; code?: string };
  return {
    error: error.message,
    name: error.name,
    code: withResponse.code,
    status: withResponse.response?.status,
    statusText: withResponse.response?.statusText,
    responseData: withResponse.response?.data ?? withResponse.data,
    stack: error.stack
  };
}

function isSlackApiError(error: unknown, code: string): boolean {
  const maybe = error as { data?: { error?: unknown }; response?: { data?: { error?: unknown } } } | undefined;
  return maybe?.data?.error === code || maybe?.response?.data?.error === code;
}

function commandPickerBlocks(language: LanguageCode, query: string, suggestions = commandSuggestions(query, 10)): any[] {
  const title = language === "ko" ? "명령어 완성 도우미" : "Command assistant";
  const help = language === "ko"
    ? "명령을 선택하세요. 인자가 필요 없는 명령은 바로 실행되고, 인자가 필요한 명령은 형식 도움을 보여줍니다."
    : "Choose a command. Commands without required arguments run immediately; commands that need arguments show focused usage help.";
  const pickerEntries = suggestions.length > 0 ? suggestions.map(({ entry }) => entry) : COMMAND_HELP.slice(0, 10);
  const options = pickerEntries.map((entry) => ({
    text: { type: "plain_text", text: optionLabel(`${entry.name} - ${language === "ko" ? entry.ko : entry.en}`) },
    value: encodeAssistActionValue({ kind: "command", command: entry.name })
  }));

  return [
    { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${help}` } },
    {
      type: "section",
      text: { type: "mrkdwn", text: renderSuggestionPreview(suggestions, language) },
      accessory: {
        type: "static_select",
        action_id: "codex_command_select",
        placeholder: { type: "plain_text", text: language === "ko" ? "명령어 선택" : "Choose command" },
        options
      }
    }
  ];
}

function sendPolicyChoiceBlocks(language: LanguageCode, text: string): any[] {
  const labels = language === "ko"
    ? { immediate: "즉시 실행", confirm: "버튼 확인", pending: "대기 유지" }
    : { immediate: "Immediate", confirm: "Confirm", pending: "Keep pending" };
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        sessionActionButton(labels.immediate, "send-policy-immediate"),
        sessionActionButton(labels.confirm, "send-policy-confirm"),
        sessionActionButton(labels.pending, "send-policy-pending", "primary")
      ]
    }
  ];
}

function skillPickerBlocks(skills: SkillDef[], filter: string, rawText: string, token: string, fallbackText: string): any[] {
  if (skills.length === 0) {
    return [{ type: "section", text: { type: "mrkdwn", text: fallbackText } }];
  }
  const options = skills.map((skill) => ({
    text: { type: "plain_text", text: optionLabel(`$${skill.name}${skill.description ? ` - ${skill.description}` : ""}`) },
    value: encodeAssistActionValue({ kind: "skill", command: skill.name, rawText, token })
  }));
  const title = filter ? `Skill matches for \`$${filter}\`` : "Configured skills";
  const previewText = skills
    .slice(0, 10)
    .map((skill) => `- ${codeInline(`$${skill.name}`)}${skill.description ? ` - ${skill.description}` : ""}`)
    .join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${previewText}` } },
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: "codex_skill_select",
          placeholder: { type: "plain_text", text: "Choose skill" },
          options
        }
      ]
    }
  ];
}

function pendingConfirmationBlocks(command: PendingCommand, language: LanguageCode, text: string): any[] {
  const labels = language === "ko"
    ? { run: "지금 실행", queue: "대기열 유지", cancel: "취소" }
    : { run: "Run now", queue: "Keep queued", cancel: "Cancel" };
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        pendingActionButton(labels.run, command.id, "run", "primary"),
        pendingActionButton(labels.queue, command.id, "queue"),
        pendingActionButton(labels.cancel, command.id, "cancel", "danger")
      ]
    }
  ];
}

function pendingActionButton(label: string, pendingId: string, command: string, style?: "primary" | "danger"): any {
  return {
    type: "button",
    action_id: "codex_pending_action",
    text: { type: "plain_text", text: label },
    value: encodeAssistActionValue({ kind: "pending-action", pendingId, command }),
    ...(style ? { style } : {})
  };
}

function renderPendingConfirmation(command: PendingCommand, language: LanguageCode): string {
  const lines = language === "ko"
    ? [
        "*Codex 실행 확인*",
        `command: ${codeInline(command.command)}`,
        `id: ${codeInline(command.id)}`,
        command.cwd ? `cwd: ${codeInline(command.cwd)}` : undefined,
        command.selector ? `selector: ${codeInline(command.selector)}` : undefined,
        command.prompt ? `prompt: ${preview(command.prompt, 500)}` : undefined,
        "",
        "어떻게 처리할지 선택하세요."
      ]
    : [
        "*Confirm Codex execution*",
        `command: ${codeInline(command.command)}`,
        `id: ${codeInline(command.id)}`,
        command.cwd ? `cwd: ${codeInline(command.cwd)}` : undefined,
        command.selector ? `selector: ${codeInline(command.selector)}` : undefined,
        command.prompt ? `prompt: ${preview(command.prompt, 500)}` : undefined,
        "",
        "Choose how to handle this command."
      ];
  return lines.filter(Boolean).join("\n");
}

function rerunPickerBlocks(sessions: SlackThreadBinding[], language: LanguageCode, text: string): any[] {
  const options = sessions
    .filter((session) => session.codexThreadId && session.lastPrompt)
    .slice(0, 100)
    .map((session, index) => ({
      text: { type: "plain_text", text: optionLabel(`${index + 1}. ${workspaceFolderName(session.cwd)} ${session.status}`) },
      description: { type: "plain_text", text: optionLabel(session.lastPrompt ?? session.cwd) },
      value: encodeAssistActionValue({ kind: "rerun-action", command: "select", sessionId: session.codexThreadId })
    }));

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: "codex_rerun_select",
          placeholder: { type: "plain_text", text: language === "ko" ? "재실행할 항목 선택" : "Choose rerun target" },
          options
        }
      ]
    }
  ];
}

function rerunSelectionBlocks(session: SlackThreadBinding, language: LanguageCode, text: string): any[] {
  const labels = language === "ko"
    ? { run: "지금 실행", queue: "대기열 추가", fullPreview: "전체보기", cancel: "취소" }
    : { run: "Run now", queue: "Queue", fullPreview: "Full preview", cancel: "Cancel" };
  const sessionId = session.codexThreadId ?? "";
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        rerunActionButton(labels.run, sessionId, "run", "primary"),
        rerunActionButton(labels.queue, sessionId, "queue"),
        rerunActionButton(labels.fullPreview, sessionId, "full-preview"),
        rerunActionButton(labels.cancel, sessionId, "cancel", "danger")
      ]
    }
  ];
}

function rerunActionButton(label: string, sessionId: string, command: string, style?: "primary" | "danger"): any {
  return {
    type: "button",
    action_id: "codex_rerun_action",
    text: { type: "plain_text", text: label },
    value: encodeAssistActionValue({ kind: "rerun-action", command, sessionId }),
    ...(style ? { style } : {})
  };
}

function renderRerunPicker(sessions: SlackThreadBinding[], language: LanguageCode): string {
  const lines = language === "ko"
    ? [
        "*재실행할 세션 선택*",
        "아래 미리보기를 확인한 뒤 드롭다운에서 항목을 선택하세요.",
        "",
        ...sessions.slice(0, 8).map((session, index) => renderRerunCandidate(session, index)),
        sessions.length > 8 ? `... 드롭다운에 ${sessions.length - 8}개 더 있음` : undefined,
        "",
        "선택 후 `전체보기`로 prompt와 마지막 응답 전체를 볼 수 있습니다."
      ]
    : [
        "*Choose a rerun target*",
        "Review the previews below, then choose an item from the dropdown.",
        "",
        ...sessions.slice(0, 8).map((session, index) => renderRerunCandidate(session, index)),
        sessions.length > 8 ? `... ${sessions.length - 8} more in the dropdown` : undefined,
        "",
        "After choosing, use `Full preview` to view the complete prompt and last response."
      ];
  return lines.filter(Boolean).join("\n");
}

function renderRerunCandidate(session: SlackThreadBinding, index: number): string {
  return [
    `${index + 1}. ${codeInline(workspaceFolderName(session.cwd))} ${codeInline(session.status)}`,
    `   session: ${session.codexThreadId ?? "unbound"}`,
    `   cwd: ${session.cwd}`,
    session.lastPrompt ? `   prompt: ${preview(session.lastPrompt, 120)}` : undefined,
    session.lastFinalAnswer ? `   last response: ${preview(session.lastFinalAnswer, 120)}` : undefined
  ].filter(Boolean).join("\n");
}

function renderRerunSelection(session: SlackThreadBinding, language: LanguageCode): string {
  const lines = language === "ko"
    ? [
        "*재실행 미리보기*",
        `workspace: ${codeInline(workspaceFolderName(session.cwd))}`,
        `cwd: ${codeInline(session.cwd)}`,
        `session: ${codeInline(session.codexThreadId ?? "unbound")}`,
        `status: ${codeInline(session.status)}`,
        "",
        `prompt: ${preview(session.lastPrompt ?? "", 1200)}`,
        session.lastFinalAnswer ? `last response: ${preview(session.lastFinalAnswer, 1200)}` : "last response: (none yet)",
        "",
        "처리 방식을 선택하세요."
      ]
    : [
        "*Rerun preview*",
        `workspace: ${codeInline(workspaceFolderName(session.cwd))}`,
        `cwd: ${codeInline(session.cwd)}`,
        `session: ${codeInline(session.codexThreadId ?? "unbound")}`,
        `status: ${codeInline(session.status)}`,
        "",
        `prompt: ${preview(session.lastPrompt ?? "", 1200)}`,
        session.lastFinalAnswer ? `last response: ${preview(session.lastFinalAnswer, 1200)}` : "last response: (none yet)",
        "",
        "Choose how to handle this rerun."
      ];
  return lines.filter(Boolean).join("\n");
}

function renderRerunFullPreview(session: SlackThreadBinding, language: LanguageCode): string {
  const title = language === "ko" ? "*재실행 전체보기*" : "*Full rerun preview*";
  const noResponse = language === "ko" ? "(아직 마지막 응답 없음)" : "(none yet)";
  return [
    title,
    `workspace: ${workspaceFolderName(session.cwd)}`,
    `cwd: ${session.cwd}`,
    `session: ${session.codexThreadId ?? "unbound"}`,
    `status: ${session.status}`,
    "",
    language === "ko" ? "prompt 전체:" : "full prompt:",
    session.lastPrompt ?? "",
    "",
    language === "ko" ? "마지막 응답 전체:" : "full last response:",
    session.lastFinalAnswer ?? noResponse
  ].join("\n");
}

function sessionQuickActionBlocks(language: LanguageCode, text: string, sendMode: boolean, sendPolicy: SendPolicy): any[] {
  const labels = language === "ko"
    ? {
        newSameRepo: "새 세션",
        bindRecent: "최근 연결",
        unbindSession: "세션 해제",
        sendModeToggle: sendMode ? "Send mode 끄기" : "Send mode 켜기",
        immediate: "즉시 실행",
        confirm: "버튼 확인",
        pending: "모두 대기",
        status: "상태",
        recent: "최근 목록"
      }
    : {
        newSameRepo: "New session",
        bindRecent: "Bind recent",
        unbindSession: "Unbind",
        sendModeToggle: sendMode ? "Send mode off" : "Send mode on",
        immediate: "Immediate",
        confirm: "Confirm",
        pending: "Pending",
        status: "Status",
        recent: "Recent"
      };
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        sessionActionButton(labels.newSameRepo, "new-same-repo", "primary"),
        sessionActionButton(labels.bindRecent, "bind-recent"),
        sessionActionButton(labels.unbindSession, "unbind-session", "danger"),
        sessionActionButton(labels.sendModeToggle, sendMode ? "send-mode-off" : "send-mode-on"),
        sessionActionButton(labels.immediate, "send-policy-immediate", sendPolicy === "immediate" ? "primary" : undefined),
        sessionActionButton(labels.confirm, "send-policy-confirm", sendPolicy === "confirm" ? "primary" : undefined),
        sessionActionButton(labels.pending, "send-policy-pending", sendPolicy === "pending" ? "primary" : undefined),
        sessionActionButton(labels.status, "status"),
        sessionActionButton(labels.recent, "recent")
      ]
    }
  ];
}

function sessionActionButton(label: string, command: string, style?: "primary" | "danger"): any {
  return {
    type: "button",
    action_id: "codex_session_action",
    text: { type: "plain_text", text: label },
    value: encodeAssistActionValue({ kind: "session-action", command }),
    ...(style ? { style } : {})
  };
}

function renderSessionQuickText(workspace: ResolvedWorkspace, binding: SlackThreadBinding | undefined, language: LanguageCode, sendMode: boolean, sendPolicy: SendPolicy): string {
  const lines = language === "ko"
    ? [
        "*빠른 세션 작업*",
        `cwd: ${codeInline(workspace.cwd)}`,
        workspace.projectName ? `project: ${codeInline(workspace.projectName)}` : undefined,
        binding?.codexThreadId ? `session: ${codeInline(binding.codexThreadId)}` : "session: none",
        binding?.status ? `status: ${codeInline(binding.status)}` : undefined,
        `send mode: ${codeInline(sendMode ? "on" : "off")}`,
        `send policy: ${codeInline(sendPolicy)}`,
        "",
        sendMode
          ? "`새 세션`은 같은 repo/cwd에 새 thread를 만들고 연결합니다. 일반 메시지는 Codex 입력으로 들어가고 send policy에 따라 처리됩니다."
          : "Send mode가 꺼져 있으면 일반 대화는 Codex로 보내지지 않습니다. 명시적으로 `send <prompt>`를 사용하세요."
      ]
    : [
        "*Quick session actions*",
        `cwd: ${codeInline(workspace.cwd)}`,
        workspace.projectName ? `project: ${codeInline(workspace.projectName)}` : undefined,
        binding?.codexThreadId ? `session: ${codeInline(binding.codexThreadId)}` : "session: none",
        binding?.status ? `status: ${codeInline(binding.status)}` : undefined,
        `send mode: ${codeInline(sendMode ? "on" : "off")}`,
        `send policy: ${codeInline(sendPolicy)}`,
        "",
        sendMode
          ? "`New session` creates and links a new thread for the same repo/cwd. Normal messages are handled by the send policy."
          : "When send mode is off, normal chat is not sent to Codex. Use explicit `send <prompt>` commands."
      ];
  return lines.filter(Boolean).join("\n");
}

function bindSessionPickerBlocks(sessions: SlackThreadBinding[], language: LanguageCode, text: string): any[] {
  const options = sessions
    .filter((session) => session.codexThreadId)
    .slice(0, 100)
    .map((session, index) => ({
      text: { type: "plain_text", text: optionLabel(`${index + 1}. ${workspaceFolderName(session.cwd)} ${session.status} ${session.codexThreadId}`) },
      description: { type: "plain_text", text: optionLabel(session.lastPrompt ? `prompt: ${preview(session.lastPrompt, 80)}` : session.cwd) },
      value: encodeAssistActionValue({ kind: "bind-session", sessionId: session.codexThreadId })
    }));

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: "codex_session_bind_select",
          placeholder: { type: "plain_text", text: language === "ko" ? "세션 선택" : "Choose session" },
          options
        }
      ]
    }
  ];
}

function renderBindSessionList(sessions: SlackThreadBinding[], language: LanguageCode): string {
  return [
    language === "ko" ? "연결할 세션을 선택하세요:" : "Choose a session to bind:",
    ...sessions.slice(0, 10).map((session, index) => renderBindSessionPreview(session, index)),
    sessions.length > 10
      ? language === "ko" ? `... 드롭다운에 ${sessions.length - 10}개 더 있음` : `... ${sessions.length - 10} more in the dropdown`
      : undefined,
    "",
    language === "ko"
      ? "직접 선택: `bind-session <number|codexThreadId|last>`"
      : "Direct selection: `bind-session <number|codexThreadId|last>`"
  ].filter(Boolean).join("\n");
}

function renderBindSessionPreview(session: SlackThreadBinding, index: number): string {
  return [
    `${index + 1}. ${codeInline(workspaceFolderName(session.cwd))} ${codeInline(session.status)}`,
    `   session: ${session.codexThreadId ?? "unbound"}`,
    `   cwd: ${session.cwd}`,
    session.lastPrompt ? `   prompt: ${preview(session.lastPrompt, 120)}` : undefined,
    session.lastFinalAnswer ? `   last response: ${preview(session.lastFinalAnswer, 120)}` : undefined
  ].filter(Boolean).join("\n");
}

function renderSuggestionPreview(suggestions: ReturnType<typeof commandSuggestions>, language: LanguageCode): string {
  if (suggestions.length === 0) {
    return language === "ko" ? "일치하는 명령어가 없습니다." : "No matching commands.";
  }
  return suggestions
    .map(({ entry }) => `- ${codeInline(entry.usage)} - ${language === "ko" ? entry.ko : entry.en}`)
    .join("\n");
}

function parseAssistActionValue(value: unknown): AssistActionValue {
  if (typeof value !== "string") return { kind: "command" };
  try {
    const parsed = JSON.parse(value) as AssistActionValue;
    if (!parsed || typeof parsed.kind !== "string") return { kind: "command" };
    if (parsed.kind !== "ref") return parsed;
    const key = parsed.command;
    const cached = key ? assistActionCache.get(key) : undefined;
    if (!cached || cached.expiresAt < Date.now()) {
      if (key) assistActionCache.delete(key);
      return { kind: "command" };
    }
    return cached.value;
  } catch {
    return { kind: "command" };
  }
}

function encodeAssistActionValue(value: AssistActionValue): string {
  const direct = JSON.stringify(value);
  if (direct.length <= SLACK_OPTION_VALUE_LIMIT) return direct;
  pruneAssistActionCache();
  const key = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  assistActionCache.set(key, { expiresAt: Date.now() + ASSIST_ACTION_CACHE_MS, value });
  return JSON.stringify({ kind: "ref", command: key } satisfies AssistActionValue);
}

function pruneAssistActionCache() {
  const now = Date.now();
  for (const [key, cached] of assistActionCache) {
    if (cached.expiresAt < now) assistActionCache.delete(key);
  }
}

function replaceSkillToken(rawText: string, token: string, replacement: string): string {
  if (!token) return rawText;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rawText.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`), (_, prefix: string) => `${prefix}${replacement}`);
}

function optionLabel(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 75 ? compact : `${compact.slice(0, 72)}...`;
}

function normalizeSlackChannelName(name: string): string {
  return name.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80);
}

async function findSlackChannel(client: WebClient, name: string): Promise<{ id?: string; name?: string } | undefined> {
  let cursor: string | undefined;
  do {
    const page = await client.conversations.list({
      exclude_archived: true,
      limit: 200,
      cursor,
      types: "public_channel,private_channel"
    });
    const found = page.channels?.find((channel) => channel.name === name);
    if (found) return found;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return undefined;
}

function renderRecentSession(session: SlackThreadBinding, index: number): string {
  return [
    `${index + 1}. ${codeInline(workspaceFolderName(session.cwd))} ${codeInline(session.status)}`,
    `   cwd: ${session.cwd}`,
    `   session: ${session.codexThreadId ?? "unbound"}`,
    session.key.startsWith("codex-cli:") ? "   source: local Codex CLI session" : undefined,
    session.projectName ? `   project: ${session.projectName}` : undefined,
    session.channelId && session.threadTs ? `   slack: ${session.channelId}:${session.threadTs}` : undefined,
    session.lastPrompt ? `   last prompt: ${preview(session.lastPrompt, 160)}` : undefined,
    session.lastFinalAnswer ? `   last response:\n${indentBlock(session.lastFinalAnswer)}` : "   last response: (none yet)"
  ]
    .filter(Boolean)
    .join("\n");
}

function workspaceFolderName(cwd: string): string {
  const normalized = cwd.replace(/[\\\/]+$/, "");
  return path.basename(normalized) || normalized || "workspace";
}

function indentBlock(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => `      ${line}`)
    .join("\n");
}

function renderSessionCommand(command: SessionCommandRecord | CodexCliSessionCommand, index: number): string {
  const kind = "command" in command ? ` ${codeInline(command.command)}` : "";
  const timestamp = "createdAt" in command ? command.createdAt : command.timestamp;
  return [
    `${index + 1}. ${codeInline(timestamp)}${kind}`,
    `   prompt: ${preview(command.prompt, 500)}`
  ].join("\n");
}

function renderPendingCommands(commands: PendingCommand[], language: LanguageCode): string {
  const header = language === "ko" ? "대기 중인 명령:" : "Pending commands:";
  return [
    header,
    ...commands.map((command, index) => [
      `${index + 1}. ${codeInline(command.id)} ${codeInline(command.command)}`,
      command.cwd ? `   cwd: ${command.cwd}` : undefined,
      command.selector ? `   selector: ${command.selector}` : undefined,
      command.prompt ? `   prompt: ${preview(command.prompt, 300)}` : undefined
    ].filter(Boolean).join("\n")),
    "",
    language === "ko"
      ? "수정: `pending-edit <number|id> <new prompt>` / 실행: `pending-run <number|id|all>` / 삭제: `pending-drop <number|id>`"
      : "Edit: `pending-edit <number|id> <new prompt>` / Run: `pending-run <number|id|all>` / Drop: `pending-drop <number|id>`"
  ].join("\n");
}

function preview(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3))}...`;
}

function isForce(cmd: ParsedCommand): boolean {
  return hasOption(cmd, "f") || hasOption(cmd, "force");
}

function commandPrompt(cmd: ParsedCommand): string {
  return cmd.args.join(" ").trim();
}

function normalizeLanguage(value: string | undefined): LanguageCode | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["en", "eng", "english"].includes(normalized)) return "en";
  if (["ko", "kor", "korean", "한국어", "한글"].includes(normalized)) return "ko";
  return undefined;
}

function normalizeSendMode(value: string | undefined): boolean | undefined {
  const normalized = (value ?? "status").trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled", "켜기", "켬"].includes(normalized)) return true;
  if (["off", "false", "0", "no", "disable", "disabled", "끄기", "끔"].includes(normalized)) return false;
  return undefined;
}

function normalizeSendPolicy(value: string | undefined): SendPolicy | undefined {
  const normalized = (value ?? "status").trim().toLowerCase();
  if (["immediate", "now", "run", "direct", "즉시", "즉시실행"].includes(normalized)) return "immediate";
  if (["confirm", "ask", "button", "buttons", "확인", "버튼"].includes(normalized)) return "confirm";
  if (["pending", "queue", "queued", "all-pending", "대기", "대기열"].includes(normalized)) return "pending";
  return undefined;
}

function renderSendModeStatus(enabled: boolean, language: LanguageCode): string {
  if (language === "ko") {
    return [
      `Send mode: ${codeInline(enabled ? "on" : "off")}`,
      enabled
        ? "일반 채널/스레드 메시지는 Codex 입력으로 들어갑니다. 실행 방식은 `send-policy`가 결정합니다."
        : "일반 채널/스레드 메시지는 Codex로 보내지지 않습니다. `/codex send ...`, `!codex send ...`, 또는 mention/DM을 사용하세요.",
      "변경: `send-mode on` / `send-mode off`"
    ].join("\n");
  }
  return [
    `Send mode: ${codeInline(enabled ? "on" : "off")}`,
    enabled
      ? "Normal channel/thread messages are accepted as Codex input. Execution is controlled by `send-policy`."
      : "Normal channel/thread messages are not sent to Codex. Use `/codex send ...`, `!codex send ...`, mentions, or DMs.",
    "Change: `send-mode on` / `send-mode off`"
  ].join("\n");
}

function renderSendPolicyStatus(policy: SendPolicy, language: LanguageCode): string {
  if (language === "ko") {
    const description = {
      immediate: "명령을 바로 Codex로 전송합니다. 기본값입니다.",
      confirm: "명령마다 버튼으로 `지금 실행`, `대기열 유지`, `취소`를 선택합니다.",
      pending: "실행성 명령을 모두 대기열에 넣습니다. `pending-run`으로 실행합니다."
    } satisfies Record<SendPolicy, string>;
    return [
      `Send policy: ${codeInline(policy)}`,
      description[policy],
      "변경: `send-policy immediate` / `send-policy confirm` / `send-policy pending`"
    ].join("\n");
  }
  const description = {
    immediate: "Commands are sent to Codex immediately. This is the default.",
    confirm: "Each command shows buttons for Run now, Keep queued, or Cancel.",
    pending: "Runnable commands are queued. Use `pending-run` to execute them."
  } satisfies Record<SendPolicy, string>;
  return [
    `Send policy: ${codeInline(policy)}`,
    description[policy],
    "Change: `send-policy immediate` / `send-policy confirm` / `send-policy pending`"
  ].join("\n");
}

function helpText(prefix: string, language: LanguageCode): string {
  if (language === "ko") {
    return [
      "*Codex commands*",
      "- `?` / `commands <prefix>`: 명령어 선택 메뉴",
      "- `$` / `$prefix`: 스킬 선택 메뉴",
      "- `pwd`, `ls`, `cd <path>`: 작업공간 탐색",
      "- `session` / `s`: 새 세션, 최근 연결, 해제 버튼 메뉴",
      "- `new [-f] <prompt>`: send policy에 따라 새 세션 시작",
      "- `send [-f] <prompt>`: send policy에 따라 현재 세션에 입력",
      "- `send-mode on|off|status`: 일반 대화 자동 입력 켜기/끄기",
      "- `send-policy immediate|confirm|pending`: 즉시 실행/버튼 확인/전체 대기열 모드",
      "- `recent`: Slack/로컬 CLI 세션 목록",
      "- `resume <number|id|last>`: 최근 목록에서 번호/ID로 세션 연결",
      "- `bind-session [number|id|last]`: 현재 channel/thread를 세션에 연결",
      "- `unbind-session`: 현재 세션 연결 해제",
      "- `active`: 실행 중인 CLI 세션 목록",
      "- `active --channel <name> <number>`: active CLI 세션으로 채널 생성/연결",
      "- `history [session]`: 세션 내 이전 명령 보기",
      "- `rerun`: 재실행 후보 미리보기/선택 메뉴",
      "- `rerun-command [-f] <number> [session]`: send policy에 따라 이력 명령 재실행",
      "- `pending`, `pending-edit`, `pending-run`, `pending-drop`: 대기 명령 관리",
      "- `language en|ko`: 안내 언어 변경",
      "",
      `Send mode가 켜져 있을 때만 일반 채널 메시지가 현재 세션 입력으로 들어갑니다. 기본 send policy는 \`immediate\`이고, \`confirm\` 또는 \`pending\`으로 바꿀 수 있습니다. \`/\`로 시작하는 입력은 Slack bot command로만 처리됩니다. Thread에서는 \`${prefix}\` 또는 @bot을 사용하세요.`
    ].join("\n");
  }

  return [
    "*Codex commands*",
    "- `?` / `commands <prefix>`: command picker",
    "- `$` / `$prefix`: skill picker",
    "- `pwd`, `ls`, `cd <path>`: browse workspace",
    "- `session` / `s`: buttons for new session, bind recent, and unbind",
    "- `new [-f] <prompt>`: start a new session by send policy",
    "- `send [-f] <prompt>`: continue current session by send policy",
    "- `send-mode on|off|status`: toggle normal-chat auto input",
    "- `send-policy immediate|confirm|pending`: immediate, button-confirmed, or queued execution",
    "- `recent`: Slack/local CLI sessions",
    "- `resume <number|id|last>`: bind a session from the recent list",
    "- `bind-session [number|id|last]`: bind this channel/thread to a session",
    "- `unbind-session`: remove the current session binding",
    "- `active`: running CLI sessions",
    "- `active --channel <name> <number>`: create/link a channel from an active CLI session",
    "- `history [session]`: show commands sent in a session",
    "- `rerun`: preview and choose a rerun target",
    "- `rerun-command [-f] <number> [session]`: rerun a history command by send policy",
    "- `pending`, `pending-edit`, `pending-run`, `pending-drop`: manage queued commands",
    "- `language en|ko`: change help language",
    "",
    `Normal channel messages become current-session input only when send mode is on. The default send policy is \`immediate\`; switch to \`confirm\` or \`pending\` when you want more review. Messages starting with \`/\` stay Slack bot commands. In threads, use \`${prefix}\` or @bot.`
  ].join("\n");
}

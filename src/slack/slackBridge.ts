import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import fs from "node:fs";
import { resolveUserPath } from "../config.js";
import type { BridgeConfig } from "../config.js";
import type { PathResolver, ResolvedWorkspace } from "../core/pathResolver.js";
import type { LanguageCode, PendingCommand, Store, SlackThreadBinding } from "../core/store.js";
import type { SkillRegistry } from "../core/skills.js";
import { listCodexCliSessions } from "../codex/sessionIndex.js";
import type { CodexRuntime, TurnCompletedEvent } from "../codex/controllerTypes.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { commandTarget, hasOption, optionString, parseCommand, stripBotMention, stripPrefix } from "../commands/parser.js";
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
  client: WebClient;
  respond?: (message: any) => Promise<any>;
}

export class SlackBridge {
  readonly app: App;

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
      const prefixed = stripPrefix(msg.text, env.commandPrefix);
      const isDirectMessage = msg.channel_type === "im";
      if (prefixed === undefined && !isDirectMessage) return;
      await this.handleCommand({
        userId: msg.user,
        channelId: msg.channel,
        threadTs: msg.thread_ts ?? msg.ts,
        messageTs: msg.ts,
        isSlash: false,
        rawText: prefixed ?? msg.text,
        client
      });
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

      if (this.isChannelCreationShortcut(ctx, parsed)) {
        await this.handleCreateChannelShortcut(ctx, parsed.rawArgs);
        return;
      }

      switch (parsed.name) {
        case "help":
          await this.reply(ctx, helpText(env.commandPrefix, this.currentLanguage(ctx)));
          return;
        case "projects":
          await this.reply(ctx, this.renderProjects());
          return;
        case "skills":
          await this.reply(ctx, this.renderSkills(parsed.args.join(" ").trim()));
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
        case "bind-channel":
          await this.handleBindChannel(ctx, parsed);
          return;
        case "unbind-channel":
          this.store.removeChannelBinding(ctx.channelId);
          await this.reply(ctx, "Channel binding removed.");
          return;
        case "new":
          await this.handleNew(ctx, parsed);
          return;
        case "send":
          await this.handleSend(ctx, parsed);
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
            await this.reply(ctx, this.renderSkills(parsed.rawArgs.slice(1)));
            return;
          }
          await this.reply(ctx, "Unknown command. Use `help`.");
      }
    } catch (error) {
      logger.error("command failed", { error: String(error) });
      await this.reply(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isAllowed(userId: string) {
    return env.allowAllSlackUsers || env.allowedSlackUserIds.includes(userId);
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
        language: existing?.language,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        createdBy: existing?.createdBy ?? ctx.userId
      });
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

    await this.postThread(ctx.client, channelId, undefined, [
      `Channel created for Codex navigation: ${codeInline(`#${channelName}`)}`,
      `cwd: ${codeInline(root)}`,
      "Use `/codex ls`, `/codex cd <folder>`, `/codex pwd`, then `/codex new ...` to queue work.",
      "The first real Codex command fixes this channel to the selected workspace/session."
    ].join("\n"));
    await this.reply(ctx, `Created or reused ${codeInline(`#${channelName}`)} with cwd ${codeInline(root)}.`);
  }

  private async handleBindChannel(ctx: CommandContext, cmd: ParsedCommand) {
    const target = cmd.args.join(" ").trim();
    if (!target) {
      await this.reply(ctx, "Usage: `bind-channel <project|path>`");
      return;
    }
    const resolved = this.paths.resolve(target);
    this.paths.ensureExists(resolved.cwd);
    this.store.setChannelBinding({
      channelId: ctx.channelId,
      cwd: resolved.cwd,
      projectName: resolved.projectName,
      language: this.currentLanguage(ctx),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId
    });
    await this.reply(ctx, `Channel is now bound to ${resolved.projectName ? `project ${codeInline(resolved.projectName)}` : "workspace"}: ${codeInline(resolved.cwd)}`);
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
        binding?.status ? `status: ${codeInline(binding.status)}` : undefined
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

    if (!isForce(cmd)) {
      await this.enqueuePending(ctx, {
        command: "new",
        prompt,
        cwd: workspace.cwd,
        projectName: workspace.projectName
      });
      return;
    }

    await this.startNewTurn(ctx, workspace, prompt);
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
    const { turnId, referencedSkills } = await this.codex.startTurn(binding, prompt);
    await this.postThread(ctx.client, threadContext.channelId, threadContext.threadTs, [
      `Started Codex turn ${codeInline(turnId)} in ${codeInline(workspace.cwd)}.`,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
    ].filter(Boolean).join("\n"));
  }

  private async handleSend(ctx: CommandContext, cmd: ParsedCommand) {
    const prompt = commandPrompt(cmd) || ctx.rawText;
    if (!prompt) {
      await this.reply(ctx, "Usage: `send [-f|--force] <prompt>`");
      return;
    }
    if (this.isSkillLookupText(prompt)) {
      await this.reply(ctx, this.renderSkills(prompt.slice(1)));
      return;
    }
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;
    if (!isForce(cmd)) {
      await this.enqueuePending(ctx, { command: "send", prompt });
      return;
    }
    await this.startSend(ctx, prompt);
  }

  private async startSend(ctx: CommandContext, prompt: string) {
    let binding = this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
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
    }
    const { turnId, referencedSkills } = await this.codex.sendOrSteer(binding, prompt);
    await this.postThread(ctx.client, binding.channelId, binding.threadTs, [
      `Sent to Codex turn ${codeInline(turnId)}.`,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
    ].filter(Boolean).join("\n"));
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
      await this.reply(ctx, "Usage: `resume <codexThreadId|last> [prompt]`");
      return;
    }
    const selected = this.resolveRecentSession(ctx, threadId, false);
    const codexThreadId = threadId === "last" ? selected?.codexThreadId : selected?.codexThreadId ?? threadId;
    if (!codexThreadId) throw new Error("No last Codex thread found for this channel");

    const workspace = optionString(cmd, "cwd", "project", "workspace")
      ? this.workspaceFromCommandOrContext(ctx, cmd)
      : selected
        ? { cwd: selected.cwd, projectName: selected.projectName }
        : this.workspaceFromCommandOrContext(ctx, cmd);
    const threadContext = await this.ensureSlackThread(ctx, `Codex resumed: ${codexThreadId}`);
    const key = this.store.threadKey(threadContext.channelId, threadContext.threadTs);
    const binding = await this.codex.resumeThread({
      slackKey: key,
      channelId: threadContext.channelId,
      threadTs: threadContext.threadTs,
      codexThreadId,
      cwd: workspace.cwd,
      projectName: workspace.projectName,
      createdBy: ctx.userId
    });

    const prompt = cmd.args.slice(1).join(" ").trim();
    if (prompt) {
      const { turnId, referencedSkills } = await this.codex.startTurn(binding, prompt);
      await this.postThread(ctx.client, binding.channelId, binding.threadTs, [
        `Resumed ${codeInline(codexThreadId)} and started turn ${codeInline(turnId)}.`,
        referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
      ].filter(Boolean).join("\n"));
    } else {
      await this.postThread(ctx.client, binding.channelId, binding.threadTs, `Resumed Codex thread ${codeInline(codexThreadId)} in ${codeInline(workspace.cwd)}.`);
    }
  }

  private async handleRerun(ctx: CommandContext, cmd: ParsedCommand) {
    const selected = this.resolveOptionalRerunSelection(ctx, cmd);
    const binding = selected.binding;
    if (!binding?.codexThreadId) throw new Error("No Codex session to rerun. Use `new` first.");

    const explicitPrompt = selected.prompt;
    const prompt = explicitPrompt || binding.lastPrompt;
    if (!prompt) throw new Error("No previous prompt stored for rerun");
    if (await this.replyIfUnknownSkills(ctx, prompt)) return;

    if (!isForce(cmd)) {
      await this.enqueuePending(ctx, {
        command: "rerun",
        prompt,
        selector: selected.selectorLabel
      });
      return;
    }

    await this.startRerun(ctx, binding, prompt, selected.selectorLabel);
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

    if (!isForce(cmd)) {
      await this.enqueuePending(ctx, {
        command: "rerun-session",
        prompt,
        selector
      });
      return;
    }

    await this.startRerun(ctx, binding, prompt, selector);
  }

  private async startRerun(ctx: CommandContext, binding: SlackThreadBinding, prompt: string, selectorLabel?: string) {
    if (!binding.codexThreadId) throw new Error("No Codex session to rerun. Use `new` first.");
    const codexThreadId = binding.codexThreadId;
    const target = await this.materializeSessionBinding(ctx, binding);
    const resumed = await this.codex.resumeThread({
      slackKey: target.key,
      channelId: target.channelId,
      threadTs: target.threadTs,
      codexThreadId,
      cwd: target.cwd,
      projectName: target.projectName,
      createdBy: ctx.userId
    });
    const { turnId, referencedSkills } = await this.codex.startTurn(resumed, prompt);
    await this.postThread(ctx.client, target.channelId, target.threadTs, [
      `Rerun started as turn ${codeInline(turnId)}${selectorLabel ? ` from ${codeInline(selectorLabel)}` : ""}.`,
      `cwd: ${codeInline(target.cwd)}`,
      binding.lastFinalAnswer ? `previous last response: ${preview(binding.lastFinalAnswer, 500)}` : undefined,
      referencedSkills.length ? `Skills: ${referencedSkills.map((s) => codeInline(`$${s.name}`)).join(", ")}` : undefined
    ].filter(Boolean).join("\n"));
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
    if (pending.command === "rerun" || pending.command === "rerun-session") {
      const binding = pending.selector ? this.resolveRecentSession(ctx, pending.selector) : this.currentThreadBinding(ctx) ?? this.store.findLatestForChannel(ctx.channelId);
      if (!binding?.codexThreadId) throw new Error("No Codex session to rerun");
      const prompt = pending.prompt || binding.lastPrompt;
      if (!prompt) throw new Error("Pending rerun command is missing prompt");
      await this.startRerun(ctx, binding, prompt, pending.selector);
      return;
    }
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
    const local = this.store.listThreads(limit).filter((session) => session.codexThreadId);
    const seen = new Set(local.map((session) => session.codexThreadId).filter(Boolean));
    let external: SlackThreadBinding[] = [];
    try {
      external = listCodexCliSessions({ sessionsDir: env.codexSessionsDir, limit })
        .filter((session) => !seen.has(session.id))
        .map((session) => ({
          key: `codex-cli:${session.id}`,
          channelId: "",
          threadTs: "",
          cwd: session.cwd,
          codexThreadId: session.id,
          status: "idle",
          lastPrompt: session.lastPrompt,
          lastFinalAnswer: session.lastFinalAnswer,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          createdBy: "codex-cli"
        }));
    } catch (error) {
      logger.warn("failed to read Codex CLI sessions", { sessionsDir: env.codexSessionsDir, error: String(error) });
    }
    return [...local, ...external]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
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
      language: this.currentLanguage(ctx),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId
    });
    const posted = await ctx.client.chat.postMessage({
      channel: channelId,
      text: [
        `Channel linked from recent session ${codeInline(session.codexThreadId)}.`,
        `cwd: ${codeInline(session.cwd)}`,
        session.lastFinalAnswer ? `last response: ${preview(session.lastFinalAnswer, 500)}` : undefined,
        "Use `/codex send ...` or `!codex send ...` here to continue. Commands queue by default; add `-f` to execute immediately."
      ].filter(Boolean).join("\n")
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
        title: session.title,
        language: this.currentLanguage(ctx),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: ctx.userId
      });
    }
    await this.reply(ctx, `Created or reused ${codeInline(`#${channelName}`)} and linked it to ${codeInline(session.cwd)}.`);
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
    if (!ctx.isSlash || parsed.name !== "send") return false;
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
    const posted = await ctx.client.chat.postMessage({
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
    if (ctx.isSlash && ctx.respond) {
      await ctx.respond({ response_type: "ephemeral", text });
      return;
    }
    if (ctx.threadTs) {
      await this.postThread(ctx.client, ctx.channelId, ctx.threadTs, text);
    } else {
      await this.postThread(ctx.client, ctx.channelId, undefined, text);
    }
  }

  private async postThread(client: WebClient, channel: string, threadTs: string | undefined, text: string) {
    const chunks = splitForSlack(text, env.slackMaxMessageChars);
    for (const chunk of chunks) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
    }
  }

  private renderProjects(): string {
    const projects = [...this.config.projects.values()];
    if (projects.length === 0) return "No projects configured.";
    return projects
      .map((p) => `- ${codeInline(p.name)} → ${codeInline(p.absolutePath)}${p.slackChannelName ? ` (#${p.slackChannelName})` : ""}${p.default ? " default" : ""}`)
      .join("\n");
  }

  private renderSkills(filter = ""): string {
    const normalized = filter.replace(/^\$/, "").trim();
    const skills = normalized ? this.skills.search(normalized) : this.skills.list();
    if (skills.length === 0) {
      return normalized
        ? `No skills configured matching ${codeInline(`$${normalized}`)}. Use ${codeInline("$")} or ${codeInline("skills")} to list all skills.`
        : "No skills configured.";
    }
    const title = normalized ? `Skills matching ${codeInline(`$${normalized}`)}:` : "Configured skills:";
    return [
      title,
      ...skills.map((skill) => `- ${codeInline(`$${skill.name}`)} -> ${codeInline(skill.absolutePath)}${skill.description ? ` - ${skill.description}` : ""}`)
    ].join("\n");
  }

  private isSkillLookupShortcut(parsed: ParsedCommand): boolean {
    return parsed.name === "send" && this.isSkillLookupText(parsed.rawArgs);
  }

  private isSkillLookupText(text: string): boolean {
    return /^\$[A-Za-z0-9_.-]*$/.test(text.trim());
  }

  private async replyIfUnknownSkills(ctx: CommandContext, prompt: string): Promise<boolean> {
    if (!this.skills.isStrict()) return false;
    const unknown = this.skills.unknownSkillNames(prompt);
    if (unknown.length === 0) return false;
    const lines = unknown.map((name) => {
      const suggestions = this.skills.suggestionsFor(name);
      if (suggestions.length === 0) {
        return `Unknown skill ${codeInline(`$${name}`)}. Use ${codeInline("$")} or ${codeInline("skills")} to list configured skills.`;
      }
      return `Unknown skill ${codeInline(`$${name}`)}. Did you mean ${suggestions.map((skill) => codeInline(`$${skill.name}`)).join(", ")}?`;
    });
    await this.reply(ctx, lines.join("\n"));
    return true;
  }
}

function codeInline(text: string): string {
  return `\`${String(text).replaceAll("`", "ʼ")}\``;
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
    `${index + 1}. ${codeInline(session.codexThreadId ?? "unbound")} ${codeInline(session.status)}`,
    `   cwd: ${session.cwd}`,
    session.key.startsWith("codex-cli:") ? "   source: local Codex CLI session" : undefined,
    session.projectName ? `   project: ${session.projectName}` : undefined,
    session.channelId && session.threadTs ? `   slack: ${session.channelId}:${session.threadTs}` : undefined,
    session.lastPrompt ? `   last prompt: ${preview(session.lastPrompt, 160)}` : undefined,
    session.lastFinalAnswer ? `   last response: ${preview(session.lastFinalAnswer, 300)}` : "   last response: (none yet)"
  ]
    .filter(Boolean)
    .join("\n");
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

function helpText(prefix: string, language: LanguageCode): string {
  if (language === "ko") {
    return codeBlock(`명령어:
  help
  language en|ko                 봇 안내 언어를 영어/한국어로 변경합니다.
  projects
  skills [prefix]                 등록된 skill을 봅니다. 예: skills rev
  $ 또는 $prefix                   등록된 skill 목록/검색 결과를 봅니다.
  pwd
  ls [path]                       현재 작업공간 파일/폴더를 봅니다.
  use <project|path>              현재 thread 작업공간을 설정합니다. thread가 아니면 channel 기본값을 설정합니다.
  use --channel <project|path>    channel 기본 작업공간을 설정합니다.
  bind-channel <project|path>     현재 Slack channel을 project/workspace에 연결합니다.
  unbind-channel
  new [-f] [project] <prompt>     새 Codex 작업을 대기열에 넣습니다. -f면 즉시 실행합니다.
  new --cwd <project|path> <prompt>
  send [-f] <prompt>              현재 Codex session 명령을 대기열에 넣습니다. -f면 즉시 실행합니다.
  steer <prompt>                  실행 중인 active turn에만 추가 입력합니다.
  resume <codexThreadId|last> [prompt]
  rerun [number|codexThreadId|last] [prompt]
  recent                           Slack/로컬 Codex CLI 최근 세션을 봅니다.
  recent --channel <name> [number] 최근 세션 cwd/session을 새 channel에 연결합니다.
  sessions                         recent 별칭입니다.
  rerun-session <number|codexThreadId|last> [prompt]
  pending                          대기 중인 명령을 봅니다.
  pending-edit <number|id> <prompt>
  pending-drop <number|id>
  pending-run <number|id|all>
  status
  stop

사용 예:
  ${prefix} language ko
  ${prefix} new api fix the failing tests     # 대기열에 추가
  ${prefix} new -f api fix the failing tests  # 즉시 실행
  /codex my-project-channel                   # 새 Slack channel 생성
  ${prefix} send $example inspect this repo and summarize next steps
  @YourBot send $test-fixer fix the flaky CI

참고:
  - new/send/rerun은 기본적으로 pending에 저장됩니다. 즉시 실행하려면 -f 또는 --force를 붙이세요.
  - /codex slash command는 channel에서 동작하지만 Slack thread 안에서는 동작하지 않습니다.
  - thread 안에서는 @bot 또는 ${prefix}를 사용하세요.
  - Slack은 메시지 입력 중인 $ 문자를 봇에게 실시간 전달하지 않으므로, $ 또는 $prefix를 메시지로 보내 목록을 확인하세요.
  - STRICT_SKILL_REFERENCES=1이면 $skill은 config/skills.yaml에 등록되어 있어야 합니다.`);
  }

  return codeBlock(`Commands:
  help
  language en|ko                 Change bot help/status language.
  projects
  skills [prefix]                 Show configured skills. Example: skills rev
  $ or $prefix                    Show configured skills or prefix matches.
  pwd
  ls [path]                       List files/folders in the current workspace.
  use <project|path>              Set workspace for this thread, or channel if not in a thread.
  use --channel <project|path>    Set channel default workspace.
  bind-channel <project|path>     Bind this Slack channel to a project/workspace.
  unbind-channel
  new [-f] [project] <prompt>     Queue a fresh Codex task. Use -f to execute immediately.
  new --cwd <project|path> <prompt>
  send [-f] <prompt>              Queue a command for the current Codex session. Use -f to execute immediately.
  steer <prompt>                  Add input to active in-flight turn only.
  resume <codexThreadId|last> [prompt]
  rerun [number|codexThreadId|last] [prompt]
  recent                           Show Slack and local Codex CLI recent sessions.
  recent --channel <name> [number] Create/link a channel from a recent session cwd/session.
  sessions                         Alias for recent.
  rerun-session <number|codexThreadId|last> [prompt]
  pending                          Show queued commands.
  pending-edit <number|id> <prompt>
  pending-drop <number|id>
  pending-run <number|id|all>
  status
  stop

Message usage:
  ${prefix} new api fix the failing tests     # queue for review/edit
  ${prefix} new -f api fix the failing tests  # execute immediately
  /codex my-project-channel                   # create a new Slack channel
  ${prefix} send $example inspect this repo and summarize next steps
  @YourBot send $test-fixer fix the flaky CI

Notes:
  - new/send/rerun queue by default. Add -f or --force to execute immediately.
  - Slash command /codex works in channels, but Slack slash commands do not run inside threads.
  - Use @bot or ${prefix} inside Slack threads.
  - Slack does not expose live message-composer keystrokes to bots, so send $ or $prefix as a message to look up skills.
  - $skill references must exist in config/skills.yaml when STRICT_SKILL_REFERENCES=1.`);
}

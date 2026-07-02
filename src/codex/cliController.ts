import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { BridgeConfig } from "../config.js";
import type { SkillRegistry } from "../core/skills.js";
import type { SlackThreadBinding, Store, SessionStatus } from "../core/store.js";
import { logger } from "../logger.js";
import type { CodexRuntime, CodexTurnStartResult, TurnCompletedEvent } from "./controllerTypes.js";

interface CliActiveTurn {
  slackKey: string;
  turnId: string;
  codexThreadId?: string;
  proc: ChildProcessWithoutNullStreams;
  finalAnswer: string;
  stderr: string;
  completed: boolean;
}

export interface CliExecArgsOptions {
  codexThreadId?: string;
  cwd: string;
  promptFromStdin?: boolean;
  config: BridgeConfig;
}

export class CodexCliController extends EventEmitter implements CodexRuntime {
  private readonly activeTurns = new Map<string, CliActiveTurn>();

  constructor(
    private readonly codexBin: string,
    private readonly store: Store,
    private readonly config: BridgeConfig,
    private readonly skills: SkillRegistry
  ) {
    super();
  }

  async start() {
    logger.info("using Codex CLI driver", { codexBin: this.codexBin });
  }

  async createThread(params: { slackKey: string; channelId: string; threadTs: string; cwd: string; projectName?: string; createdBy: string; title?: string }) {
    const now = new Date().toISOString();
    const binding: SlackThreadBinding = {
      key: params.slackKey,
      channelId: params.channelId,
      threadTs: params.threadTs,
      cwd: params.cwd,
      projectName: params.projectName,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
      title: params.title
    };
    this.store.upsertThreadBinding(binding);
    return binding;
  }

  async resumeThread(params: { slackKey: string; channelId: string; threadTs: string; codexThreadId: string; cwd: string; projectName?: string; createdBy: string }) {
    const now = new Date().toISOString();
    const existing = this.store.getThreadBinding(params.slackKey);
    const binding: SlackThreadBinding = {
      key: params.slackKey,
      channelId: params.channelId,
      threadTs: params.threadTs,
      cwd: params.cwd,
      projectName: params.projectName,
      codexThreadId: params.codexThreadId,
      status: existing?.status ?? "idle",
      activeTurnId: existing?.activeTurnId,
      lastPrompt: existing?.lastPrompt,
      lastFinalAnswer: existing?.lastFinalAnswer,
      title: existing?.title,
      sendMode: existing?.sendMode,
      sendPolicy: existing?.sendPolicy,
      language: existing?.language,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? params.createdBy
    };
    this.store.upsertThreadBinding(binding);
    return binding;
  }

  async startTurn(binding: SlackThreadBinding, prompt: string): Promise<CodexTurnStartResult> {
    const built = this.skills.buildCliPrompt(prompt);
    if (built.unknownSkillNames.length > 0) {
      throw new Error(`Unknown or unavailable skill reference: ${built.unknownSkillNames.join(", ")}`);
    }

    const turnId = `cli-turn-${Date.now()}`;
    const args = buildCodexCliArgs({
      codexThreadId: binding.codexThreadId,
      cwd: binding.cwd,
      promptFromStdin: true,
      config: this.config
    });
    logger.info("starting Codex CLI turn", { turnId, cwd: binding.cwd, resume: Boolean(binding.codexThreadId) });
    const proc = spawn(this.codexBin, args, {
      cwd: binding.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const active: CliActiveTurn = {
      slackKey: binding.key,
      turnId,
      codexThreadId: binding.codexThreadId,
      proc,
      finalAnswer: "",
      stderr: "",
      completed: false
    };
    this.activeTurns.set(turnId, active);
    this.store.updateThread(binding.key, {
      activeTurnId: turnId,
      status: "active",
      lastPrompt: prompt
    });

    this.attachProcessHandlers(active);
    proc.stdin.end(built.prompt);

    return { turnId, referencedSkills: built.referencedSkills };
  }

  async sendOrSteer(binding: SlackThreadBinding, prompt: string): Promise<CodexTurnStartResult> {
    if (binding.status === "active" && binding.activeTurnId) {
      return this.steer(binding, prompt);
    }
    return this.startTurn(binding, prompt);
  }

  async steer(_binding: SlackThreadBinding, _prompt: string): Promise<CodexTurnStartResult> {
    throw new Error("The Codex CLI driver cannot steer an active non-interactive turn. Wait for the turn to finish, then use `send`.");
  }

  async interrupt(binding: SlackThreadBinding) {
    const active = binding.activeTurnId ? this.activeTurns.get(binding.activeTurnId) : undefined;
    if (!active) throw new Error("No active Codex CLI process is bound to this Slack thread");
    active.proc.kill("SIGTERM");
  }

  private attachProcessHandlers(active: CliActiveTurn) {
    let stdoutBuffer = "";

    active.proc.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) this.handleJsonLine(active, line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    active.proc.stderr.on("data", (chunk) => {
      active.stderr += String(chunk);
    });

    active.proc.on("exit", (code, signal) => {
      const trailing = stdoutBuffer.trim();
      if (trailing) this.handleJsonLine(active, trailing);
      if (!active.completed) {
        const status: SessionStatus = signal ? "interrupted" : "failed";
        this.finishTurn(active, status, active.finalAnswer || active.stderr.trim() || `Codex CLI exited with code ${code ?? "unknown"}`, active.stderr.trim() || undefined);
      }
    });
  }

  private handleJsonLine(active: CliActiveTurn, line: string) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      logger.debug("non-json Codex CLI output", { line });
      return;
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      active.codexThreadId = event.thread_id;
      this.store.updateThread(active.slackKey, { codexThreadId: event.thread_id });
      return;
    }

    if (event.type === "item.completed") {
      const item = event.item ?? {};
      if ((item.type === "agent_message" || item.type === "agentMessage") && typeof item.text === "string") {
        active.finalAnswer = item.text;
      }
      return;
    }

    if (event.type === "turn.completed") {
      active.completed = true;
      this.finishTurn(active, "completed", active.finalAnswer.trim() || "Codex CLI turn completed.");
    }
  }

  private finishTurn(active: CliActiveTurn, status: SessionStatus, finalAnswer: string, errorMessage?: string) {
    const binding = this.store.getThreadBinding(active.slackKey);
    if (!binding) return;
    const codexThreadId = active.codexThreadId ?? binding.codexThreadId ?? "cli-unknown-thread";
    this.store.updateThread(active.slackKey, {
      codexThreadId,
      activeTurnId: undefined,
      status,
      lastFinalAnswer: finalAnswer
    });
    this.activeTurns.delete(active.turnId);
    this.emit("turnCompleted", {
      slackKey: active.slackKey,
      channelId: binding.channelId,
      threadTs: binding.threadTs,
      codexThreadId,
      turnId: active.turnId,
      status,
      finalAnswer,
      errorMessage
    } satisfies TurnCompletedEvent);
  }
}

export function buildCodexCliArgs(options: CliExecArgsOptions): string[] {
  const args = options.codexThreadId
    ? ["exec", "resume", "--json", options.codexThreadId]
    : ["exec", "--json", "--skip-git-repo-check", "-C", options.cwd];

  const model = options.config.defaults.model;
  if (model) args.push("-m", model);

  const sandbox = normalizeSandbox(options.config.defaults.sandbox);
  if (sandbox && !options.codexThreadId) args.push("-s", sandbox);

  const approvalPolicy = options.config.defaults.approvalPolicy;
  if (approvalPolicy && !options.codexThreadId) args.push("-a", approvalPolicy);

  if (options.promptFromStdin) args.push("-");
  return args;
}

export function normalizeSandbox(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  const map: Record<string, string> = {
    readOnly: "read-only",
    "read-only": "read-only",
    workspaceWrite: "workspace-write",
    "workspace-write": "workspace-write",
    dangerFullAccess: "danger-full-access",
    "danger-full-access": "danger-full-access"
  };
  return map[normalized] ?? normalized;
}

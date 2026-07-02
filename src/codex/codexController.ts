import { EventEmitter } from "node:events";
import type { BridgeConfig } from "../config.js";
import type { Store, SlackThreadBinding, SessionStatus } from "../core/store.js";
import { SkillRegistry } from "../core/skills.js";
import { logger } from "../logger.js";
import type { AppServerClient } from "./appServerClient.js";
import type { CodexRuntime, TurnCompletedEvent } from "./controllerTypes.js";

interface ActiveTurnState {
  slackKey: string;
  codexThreadId: string;
  turnId: string;
  finalAnswer: string;
  commandSummaries: string[];
}

export interface StartTurnOptions {
  slackKey: string;
  prompt: string;
  cwd: string;
  projectName?: string;
}

export class CodexController extends EventEmitter implements CodexRuntime {
  private readonly activeTurns = new Map<string, ActiveTurnState>();

  constructor(
    private readonly client: AppServerClient,
    private readonly store: Store,
    private readonly config: BridgeConfig,
    private readonly skills: SkillRegistry
  ) {
    super();
    this.client.on("notification", (n) => this.handleNotification(n));
    this.client.on("serverRequest", (r) => this.handleServerRequest(r));
  }

  async start() {
    await this.client.start();
  }

  async createThread(params: { slackKey: string; channelId: string; threadTs: string; cwd: string; projectName?: string; createdBy: string; title?: string }) {
    const response = await this.client.rpc("thread/start", {
      cwd: params.cwd,
      sandbox: this.config.defaults.sandbox,
      approvalPolicy: this.config.defaults.approvalPolicy,
      ...(this.config.defaults.model ? { model: this.config.defaults.model } : {}),
      ...(this.config.defaults.reasoningEffort ? { reasoningEffort: this.config.defaults.reasoningEffort } : {})
    });

    const thread = response?.thread ?? response;
    const codexThreadId = thread?.id;
    if (!codexThreadId) throw new Error("thread/start did not return thread.id");

    const now = new Date().toISOString();
    const binding: SlackThreadBinding = {
      key: params.slackKey,
      channelId: params.channelId,
      threadTs: params.threadTs,
      cwd: params.cwd,
      projectName: params.projectName,
      codexThreadId,
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
    const response = await this.client.rpc("thread/resume", {
      threadId: params.codexThreadId,
      cwd: params.cwd,
      sandbox: this.config.defaults.sandbox,
      approvalPolicy: this.config.defaults.approvalPolicy,
      ...(this.config.defaults.model ? { model: this.config.defaults.model } : {})
    });
    const thread = response?.thread ?? response;
    const threadId = thread?.id ?? params.codexThreadId;
    const now = new Date().toISOString();
    const existing = this.store.getThreadBinding(params.slackKey);
    const binding: SlackThreadBinding = {
      key: params.slackKey,
      channelId: params.channelId,
      threadTs: params.threadTs,
      cwd: params.cwd,
      projectName: params.projectName,
      codexThreadId: threadId,
      status: existing?.status ?? "idle",
      activeTurnId: existing?.activeTurnId,
      lastPrompt: existing?.lastPrompt,
      lastFinalAnswer: existing?.lastFinalAnswer,
      title: existing?.title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? params.createdBy
    };
    this.store.upsertThreadBinding(binding);
    return binding;
  }

  async startTurn(binding: SlackThreadBinding, prompt: string) {
    if (!binding.codexThreadId) throw new Error("No Codex thread is bound to this Slack thread");
    const built = this.skills.buildInput(prompt);
    if (built.unknownSkillNames.length > 0) {
      throw new Error(`Unknown or unavailable skill reference: ${built.unknownSkillNames.join(", ")}`);
    }

    const result = await this.client.rpc("turn/start", {
      threadId: binding.codexThreadId,
      input: built.input,
      cwd: binding.cwd,
      clientUserMessageId: `slack:${binding.key}:${Date.now()}`,
      sandbox: this.config.defaults.sandbox,
      approvalPolicy: this.config.defaults.approvalPolicy,
      ...(this.config.defaults.model ? { model: this.config.defaults.model } : {}),
      ...(this.config.defaults.reasoningEffort ? { reasoningEffort: this.config.defaults.reasoningEffort } : {})
    });

    const turn = result?.turn ?? result;
    const turnId = turn?.id;
    if (!turnId) throw new Error("turn/start did not return turn.id");

    this.activeTurns.set(turnId, {
      slackKey: binding.key,
      codexThreadId: binding.codexThreadId,
      turnId,
      finalAnswer: "",
      commandSummaries: []
    });
    this.store.updateThread(binding.key, {
      activeTurnId: turnId,
      status: "active",
      lastPrompt: prompt
    });
    return { turnId, referencedSkills: built.referencedSkills };
  }

  async sendOrSteer(binding: SlackThreadBinding, prompt: string) {
    if (binding.status === "active" && binding.activeTurnId && binding.codexThreadId) {
      return this.steer(binding, prompt);
    }
    return this.startTurn(binding, prompt);
  }

  async steer(binding: SlackThreadBinding, prompt: string) {
    if (!binding.codexThreadId || !binding.activeTurnId) {
      throw new Error("This Slack thread has no active Codex turn to steer");
    }
    const built = this.skills.buildInput(prompt);
    if (built.unknownSkillNames.length > 0) {
      throw new Error(`Unknown or unavailable skill reference: ${built.unknownSkillNames.join(", ")}`);
    }
    const result = await this.client.rpc("turn/steer", {
      threadId: binding.codexThreadId,
      expectedTurnId: binding.activeTurnId,
      input: built.input,
      clientUserMessageId: `slack-steer:${binding.key}:${Date.now()}`
    });
    this.store.updateThread(binding.key, { lastPrompt: prompt });
    return { turnId: result?.turnId ?? binding.activeTurnId, referencedSkills: built.referencedSkills };
  }

  async interrupt(binding: SlackThreadBinding) {
    if (!binding.codexThreadId) throw new Error("No Codex thread is bound");
    await this.client.rpc("turn/interrupt", { threadId: binding.codexThreadId });
  }

  async listAppServerThreads(limit = 20): Promise<any[]> {
    try {
      const result = await this.client.rpc("thread/list", { limit });
      return result?.threads ?? result?.data ?? [];
    } catch (error) {
      logger.warn("thread/list failed; falling back to local store only", { error: String(error) });
      return [];
    }
  }

  private handleNotification(msg: { method: string; params?: any }) {
    const params = msg.params ?? {};
    switch (msg.method) {
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        const turnId = params.turnId ?? params.turn?.id;
        const delta = params.delta ?? params.text ?? params.content ?? "";
        if (turnId && this.activeTurns.has(turnId)) {
          const active = this.activeTurns.get(turnId)!;
          active.finalAnswer += String(delta);
        }
        break;
      }
      case "item/completed": {
        const item = params.item ?? params;
        const turnId = params.turnId ?? params.turn?.id ?? item.turnId;
        if (!turnId || !this.activeTurns.has(turnId)) break;
        const active = this.activeTurns.get(turnId)!;
        if (item.type === "agentMessage" && typeof item.text === "string") {
          active.finalAnswer = item.text;
        }
        if (item.type === "commandExecution") {
          const status = item.status ?? "unknown";
          const command = item.command ?? item.cmd ?? item.argv?.join(" ") ?? "command";
          active.commandSummaries.push(`${status}: ${command}`);
        }
        break;
      }
      case "turn/started": {
        const turnId = params.turn?.id ?? params.turnId;
        if (turnId && this.activeTurns.has(turnId)) {
          const active = this.activeTurns.get(turnId)!;
          this.store.updateThread(active.slackKey, { activeTurnId: turnId, status: "active" });
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn ?? params;
        const turnId = turn?.id ?? params.turnId;
        const threadId = params.threadId ?? turn?.threadId;
        let active = turnId ? this.activeTurns.get(turnId) : undefined;
        if (!active && threadId) {
          const binding = this.store.getThreadBindingByCodexThread(threadId);
          if (binding?.activeTurnId) active = this.activeTurns.get(binding.activeTurnId);
        }
        if (!active) break;

        const binding = this.store.getThreadBinding(active.slackKey);
        if (!binding || !binding.codexThreadId) break;

        const status = normalizeStatus(turn?.status);
        const errorMessage = turn?.error?.message;
        const finalAnswer = active.finalAnswer.trim() || summarizeTurnFallback(turn, active.commandSummaries, errorMessage);
        this.store.updateThread(active.slackKey, {
          activeTurnId: undefined,
          status,
          lastFinalAnswer: finalAnswer
        });
        this.activeTurns.delete(active.turnId);
        this.emit("turnCompleted", {
          slackKey: active.slackKey,
          channelId: binding.channelId,
          threadTs: binding.threadTs,
          codexThreadId: binding.codexThreadId,
          turnId: active.turnId,
          status,
          finalAnswer,
          errorMessage
        } satisfies TurnCompletedEvent);
        break;
      }
      default:
        break;
    }
  }

  private handleServerRequest(msg: any) {
    logger.warn("server request received; declining by default", { method: msg.method, id: msg.id });
    // Safe default. Users can loosen Codex approval policy or implement Slack buttons here.
    this.client.respond(msg.id, { decision: "decline", action: "decline", content: null });
  }
}

function normalizeStatus(value: string | undefined): SessionStatus {
  if (value === "failed") return "failed";
  if (value === "interrupted") return "interrupted";
  return "completed";
}

function summarizeTurnFallback(turn: any, commandSummaries: string[], errorMessage?: string): string {
  if (errorMessage) return `Codex turn failed: ${errorMessage}`;
  if (commandSummaries.length) return `Codex turn completed.\n\nCommands:\n${commandSummaries.slice(-10).join("\n")}`;
  if (turn?.status) return `Codex turn completed with status: ${turn.status}`;
  return "Codex turn completed.";
}

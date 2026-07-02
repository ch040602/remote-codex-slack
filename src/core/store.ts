import fs from "node:fs";
import path from "node:path";

export type SessionStatus = "idle" | "active" | "completed" | "failed" | "interrupted";
export type LanguageCode = "en" | "ko";

export interface ChannelBinding {
  channelId: string;
  projectName?: string;
  cwd: string;
  language?: LanguageCode;
  updatedAt: string;
  updatedBy: string;
}

export interface SlackThreadBinding {
  key: string;
  channelId: string;
  threadTs: string;
  projectName?: string;
  cwd: string;
  codexThreadId?: string;
  activeTurnId?: string;
  status: SessionStatus;
  lastPrompt?: string;
  lastFinalAnswer?: string;
  sessionCommands?: Array<{ timestamp: string; prompt: string }>;
  title?: string;
  language?: LanguageCode;
  updatedAt: string;
  createdAt: string;
  createdBy: string;
}

export type PendingCommandKind = "new" | "send" | "rerun" | "rerun-session";

export interface PendingCommand {
  id: string;
  scopeKey: string;
  channelId: string;
  threadTs?: string;
  command: PendingCommandKind;
  prompt?: string;
  cwd?: string;
  projectName?: string;
  selector?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface SessionCommandRecord {
  id: string;
  slackKey: string;
  channelId: string;
  threadTs?: string;
  codexThreadId?: string;
  command: PendingCommandKind;
  prompt: string;
  cwd: string;
  projectName?: string;
  createdAt: string;
  createdBy: string;
}

export interface StateShape {
  channelBindings: Record<string, ChannelBinding>;
  threadBindings: Record<string, SlackThreadBinding>;
  codexThreadToSlackKey: Record<string, string>;
  pendingCommands: Record<string, PendingCommand>;
  commandHistory: Record<string, SessionCommandRecord>;
}

const EMPTY: StateShape = {
  channelBindings: {},
  threadBindings: {},
  codexThreadToSlackKey: {},
  pendingCommands: {},
  commandHistory: {}
};

export class Store {
  private state: StateShape = structuredClone(EMPTY);

  constructor(private readonly filePath: string) {}

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = structuredClone(EMPTY);
      this.save();
      return;
    }
    const loaded = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StateShape>;
    this.state = {
      channelBindings: loaded.channelBindings ?? {},
      threadBindings: loaded.threadBindings ?? {},
      codexThreadToSlackKey: loaded.codexThreadToSlackKey ?? {},
      pendingCommands: loaded.pendingCommands ?? {},
      commandHistory: loaded.commandHistory ?? {}
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  getChannelBinding(channelId: string): ChannelBinding | undefined {
    return this.state.channelBindings[channelId];
  }

  setChannelBinding(binding: ChannelBinding) {
    const existing = this.state.channelBindings[binding.channelId];
    this.state.channelBindings[binding.channelId] = { ...existing, ...binding };
    this.save();
  }

  removeChannelBinding(channelId: string) {
    delete this.state.channelBindings[channelId];
    this.save();
  }

  threadKey(channelId: string, threadTs: string): string {
    return `${channelId}:${threadTs}`;
  }

  getThreadBinding(key: string): SlackThreadBinding | undefined {
    return this.state.threadBindings[key];
  }

  getThreadBindingByCodexThread(codexThreadId: string): SlackThreadBinding | undefined {
    const key = this.state.codexThreadToSlackKey[codexThreadId];
    return key ? this.getThreadBinding(key) : undefined;
  }

  upsertThreadBinding(binding: SlackThreadBinding) {
    this.state.threadBindings[binding.key] = binding;
    if (binding.codexThreadId) {
      this.state.codexThreadToSlackKey[binding.codexThreadId] = binding.key;
    }
    this.save();
  }

  removeThreadBinding(key: string): SlackThreadBinding | undefined {
    const current = this.state.threadBindings[key];
    if (!current) return undefined;
    delete this.state.threadBindings[key];
    if (current.codexThreadId && this.state.codexThreadToSlackKey[current.codexThreadId] === key) {
      delete this.state.codexThreadToSlackKey[current.codexThreadId];
    }
    this.save();
    return current;
  }

  updateThread(key: string, patch: Partial<SlackThreadBinding>): SlackThreadBinding {
    const current = this.state.threadBindings[key];
    if (!current) throw new Error(`No Slack thread binding: ${key}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.upsertThreadBinding(next);
    return next;
  }

  listThreads(limit = 20): SlackThreadBinding[] {
    return Object.values(this.state.threadBindings)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  findLatestForChannel(channelId: string): SlackThreadBinding | undefined {
    return this.listThreads(100).find((s) => s.channelId === channelId && s.codexThreadId);
  }

  addPendingCommand(command: Omit<PendingCommand, "id" | "createdAt" | "updatedAt">): PendingCommand {
    const now = new Date().toISOString();
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const pending: PendingCommand = { ...command, id, createdAt: now, updatedAt: now };
    this.state.pendingCommands[id] = pending;
    this.save();
    return pending;
  }

  listPendingCommands(scopeKey: string): PendingCommand[] {
    return Object.values(this.state.pendingCommands)
      .filter((p) => p.scopeKey === scopeKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getPendingCommand(id: string): PendingCommand | undefined {
    return this.state.pendingCommands[id];
  }

  updatePendingCommand(id: string, patch: Partial<Omit<PendingCommand, "id" | "createdAt">>): PendingCommand {
    const current = this.state.pendingCommands[id];
    if (!current) throw new Error(`No pending command: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.state.pendingCommands[id] = next;
    this.save();
    return next;
  }

  removePendingCommand(id: string): PendingCommand | undefined {
    const current = this.state.pendingCommands[id];
    if (!current) return undefined;
    delete this.state.pendingCommands[id];
    this.save();
    return current;
  }

  addSessionCommand(command: Omit<SessionCommandRecord, "id" | "createdAt">): SessionCommandRecord {
    const id = `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const saved: SessionCommandRecord = { ...command, id, createdAt: new Date().toISOString() };
    this.state.commandHistory[id] = saved;
    this.save();
    return saved;
  }

  listSessionCommands(binding: Pick<SlackThreadBinding, "key" | "codexThreadId">): SessionCommandRecord[] {
    return Object.values(this.state.commandHistory)
      .filter((command) => command.slackKey === binding.key || Boolean(binding.codexThreadId && command.codexThreadId === binding.codexThreadId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

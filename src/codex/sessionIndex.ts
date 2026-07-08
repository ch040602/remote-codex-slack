import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface CodexCliSessionSummary {
  id: string;
  cwd: string;
  status: "idle" | "active";
  turnActive: boolean;
  createdAt: string;
  updatedAt: string;
  path: string;
  title?: string;
  lastPrompt?: string;
  lastFinalAnswer?: string;
  commands: CodexCliSessionCommand[];
}

export interface CodexCliSessionCommand {
  timestamp: string;
  prompt: string;
}

export interface CodexCliSessionListOptions {
  sessionsDir?: string;
  limit?: number;
  activeSessionIds?: Iterable<string>;
  detectActiveProcesses?: boolean;
  useCache?: boolean;
}

const SESSION_FILE_CACHE_MS = 30_000;
const ACTIVE_PROCESS_CACHE_MS = 15_000;
const SUMMARY_HEAD_BYTES = 64 * 1024;
const SUMMARY_TAIL_BYTES = 256 * 1024;

let sessionFileCache: { root: string; expiresAt: number; files: Array<{ path: string; mtime: Date; mtimeMs: number }> } | undefined;
let activeProcessCache: { expiresAt: number; ids: Set<string> } | undefined;
const sessionListCache = new Map<string, { expiresAt: number; sessions: CodexCliSessionSummary[] }>();

export function defaultCodexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function listCodexCliSessions(options: CodexCliSessionListOptions = {}): CodexCliSessionSummary[] {
  const sessionsDir = options.sessionsDir ?? defaultCodexSessionsDir();
  const limit = options.limit ?? 50;
  if (!fs.existsSync(sessionsDir)) return [];
  const detectActiveProcesses = options.detectActiveProcesses !== false;
  const useCache = options.useCache !== false;
  const cacheKey = useCache && options.activeSessionIds === undefined ? `${sessionsDir}|${limit}|${detectActiveProcesses}` : undefined;
  const cached = cacheKey ? sessionListCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.sessions.slice(0, limit);

  const activeSessionIds = new Set(Array.from(options.activeSessionIds ?? [], (id) => id.toLowerCase()));
  if (detectActiveProcesses) {
    for (const id of detectActiveCodexCliSessionIds()) activeSessionIds.add(id);
  }

  const candidateLimit = Math.max(limit * 2, limit + 10);
  const sessions = findSessionFiles(sessionsDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, candidateLimit)
    .map((entry) => readCodexCliSession(entry.path, entry.mtime, activeSessionIds, { compact: true }))
    .filter((session): session is CodexCliSessionSummary => Boolean(session))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(uniqueSessionId())
    .slice(0, limit);
  if (cacheKey) {
    sessionListCache.set(cacheKey, { expiresAt: Date.now() + SESSION_FILE_CACHE_MS, sessions });
  }
  return sessions;
}

export function readCodexCliSession(
  filePath: string,
  fallbackMtime = new Date(),
  activeSessionIds: ReadonlySet<string> = new Set(),
  options: { compact?: boolean } = {}
): CodexCliSessionSummary | undefined {
  let id = sessionIdFromFilename(filePath);
  let cwd = "";
  let createdAt = fallbackMtime.toISOString();
  let updatedAt = "";
  let firstUserPrompt = "";
  let lastPrompt = "";
  let lastFinalAnswer = "";
  let lastTaskStartedAt = "";
  let lastTaskCompletedAt = "";
  const commands: CodexCliSessionCommand[] = [];

  const content = options.compact ? readCompactSessionText(filePath) : fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    if (timestamp && timestamp.localeCompare(updatedAt) > 0) updatedAt = timestamp;

    if (event.type === "session_meta") {
      const payload = event.payload ?? {};
      id = payload.session_id ?? payload.id ?? id;
      cwd = payload.cwd ?? cwd;
      createdAt = payload.timestamp ?? timestamp ?? createdAt;
      continue;
    }

    if (event.type === "turn_context" && typeof event.payload?.cwd === "string") {
      cwd = event.payload.cwd;
      continue;
    }

    const payload = event.payload ?? {};
    if (event.type === "event_msg" && payload.type === "task_started") {
      lastTaskStartedAt = timestamp ?? (updatedAt || fallbackMtime.toISOString());
      continue;
    }
    if (event.type === "event_msg" && payload.type === "task_complete") {
      lastTaskCompletedAt = timestamp ?? (updatedAt || fallbackMtime.toISOString());
      continue;
    }

    if (payload.type === "message" && payload.role === "user") {
      const text = extractText(payload.content);
      if (text) {
        if (!firstUserPrompt) firstUserPrompt = text;
        lastPrompt = text;
        commands.push({ timestamp: timestamp ?? (updatedAt || fallbackMtime.toISOString()), prompt: text });
      }
      continue;
    }

    if (payload.type === "message" && payload.role === "assistant") {
      const text = extractText(payload.content);
      if (text) lastFinalAnswer = text;
      continue;
    }

    if (payload.type === "user_message") {
      const text = extractText(payload.message);
      if (text) {
        if (!firstUserPrompt) firstUserPrompt = text;
        lastPrompt = text;
        commands.push({ timestamp: timestamp ?? (updatedAt || fallbackMtime.toISOString()), prompt: text });
      }
      continue;
    }

    if (payload.type === "agent_message") {
      const text = extractText(payload.message);
      if (text) lastFinalAnswer = text;
    }
  }

  if (!id || !cwd) return undefined;
  const finalUpdatedAt = updatedAt || fallbackMtime.toISOString();
  const hasOpenTurn = Boolean(lastTaskStartedAt && (!lastTaskCompletedAt || lastTaskStartedAt.localeCompare(lastTaskCompletedAt) > 0));
  const hasOpenCliProcess = activeSessionIds.has(id.toLowerCase());
  return {
    id,
    cwd,
    status: hasOpenTurn || hasOpenCliProcess ? "active" : "idle",
    turnActive: hasOpenTurn,
    createdAt,
    updatedAt: finalUpdatedAt,
    path: filePath,
    title: firstUserPrompt ? preview(firstUserPrompt, 80) : undefined,
    lastPrompt: lastPrompt || undefined,
    lastFinalAnswer: lastFinalAnswer || undefined,
    commands
  };
}

function readCompactSessionText(filePath: string): string {
  const stat = fs.statSync(filePath);
  const maxCompactBytes = SUMMARY_HEAD_BYTES + SUMMARY_TAIL_BYTES;
  if (stat.size <= maxCompactBytes) return fs.readFileSync(filePath, "utf8");

  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(SUMMARY_HEAD_BYTES);
    const tail = Buffer.alloc(SUMMARY_TAIL_BYTES);
    const headBytes = fs.readSync(fd, head, 0, SUMMARY_HEAD_BYTES, 0);
    const tailStart = Math.max(0, stat.size - SUMMARY_TAIL_BYTES);
    const tailBytes = fs.readSync(fd, tail, 0, SUMMARY_TAIL_BYTES, tailStart);
    return `${head.subarray(0, headBytes).toString("utf8")}\n${tail.subarray(0, tailBytes).toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

export function detectActiveCodexCliSessionIds(): Set<string> {
  const now = Date.now();
  if (activeProcessCache && activeProcessCache.expiresAt > now) {
    return new Set(activeProcessCache.ids);
  }
  const ids = extractCodexSessionIdsFromProcessOutput(readProcessCommandLines());
  activeProcessCache = { expiresAt: now + ACTIVE_PROCESS_CACHE_MS, ids };
  return new Set(ids);
}

export function extractCodexSessionIdsFromProcessOutput(output: string): Set<string> {
  const active = new Set<string>();
  const sessionId = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = sessionId.exec(output)) !== null) {
    active.add(match[1].toLowerCase());
  }
  return active;
}

function findSessionFiles(root: string): Array<{ path: string; mtime: Date; mtimeMs: number }> {
  const now = Date.now();
  if (sessionFileCache && sessionFileCache.root === root && sessionFileCache.expiresAt > now) {
    return [...sessionFileCache.files];
  }

  const result: Array<{ path: string; mtime: Date; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(fullPath);
        result.push({ path: fullPath, mtime: stat.mtime, mtimeMs: stat.mtimeMs });
      }
    }
  }
  sessionFileCache = { root, expiresAt: now + SESSION_FILE_CACHE_MS, files: result };
  return result;
}

function uniqueSessionId(): (session: CodexCliSessionSummary) => boolean {
  const seen = new Set<string>();
  return (session) => {
    const id = session.id.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

function extractText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n").trim();
  }
  if (typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "output"]) {
    if (typeof record[key] === "string") return String(record[key]).trim();
  }
  for (const key of ["content", "item"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return "";
}

function readProcessCommandLines(): string {
  try {
    if (process.platform === "win32") {
      const powershellOutput = readWindowsProcessCommandLinesWithPowerShell();
      if (powershellOutput) return powershellOutput;
      return readWindowsProcessCommandLinesWithWmic();
    }
    return execFileSync("ps", ["-axo", "command"], { encoding: "utf8", timeout: 8000 })
      .split(/\r?\n/)
      .filter((line) => /codex/i.test(line))
      .join("\n");
  } catch {
    return "";
  }
}

function readWindowsProcessCommandLinesWithPowerShell(): string {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%codex%'\" | Select-Object -ExpandProperty CommandLine"
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    );
  } catch {
    return "";
  }
}

function readWindowsProcessCommandLinesWithWmic(): string {
  try {
    return execFileSync(
      "wmic.exe",
      ["process", "get", "CommandLine", "/value"],
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    );
  } catch {
    return "";
  }
}

function sessionIdFromFilename(filePath: string): string | undefined {
  return path.basename(filePath, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1];
}

function preview(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3))}...`;
}

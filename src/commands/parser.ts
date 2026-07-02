import type { CommandName, ParsedCommand } from "./types.js";

const KNOWN = new Set<CommandName>([
  "help",
  "commands",
  "projects",
  "skills",
  "language",
  "lang",
  "언어",
  "use",
  "cd",
  "ls",
  "pwd",
  "new",
  "send",
  "send-mode",
  "send-policy",
  "session",
  "s",
  "steer",
  "resume",
  "rerun",
  "rerun-session",
  "recent",
  "sessions",
  "active",
  "history",
  "rerun-command",
  "pending",
  "pending-edit",
  "pending-drop",
  "pending-run",
  "status",
  "stop",
  "bind-session",
  "unbind-session"
]);

const BOOLEAN_OPTIONS = new Set(["force"]);

export function stripBotMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/, "").trim();
}

export function stripPrefix(text: string, prefix: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === prefix.toLowerCase()) return "help";
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase() + " ")) {
    return trimmed.slice(prefix.length).trim();
  }
  return undefined;
}

export function normalizeSlackMessageText(text: string, commandPrefix: string, isDirectMessage: boolean): string | undefined {
  const prefixed = stripPrefix(text, commandPrefix);
  if (prefixed !== undefined) return prefixed;

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return undefined;
  return isDirectMessage ? trimmed : `send ${trimmed}`;
}

export function isPlainSlackChannelMessage(text: string, commandPrefix: string, isDirectMessage: boolean): boolean {
  if (isDirectMessage) return false;
  if (stripPrefix(text, commandPrefix) !== undefined) return false;
  const trimmed = text.trim();
  return Boolean(trimmed) && !trimmed.startsWith("/");
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed) return { name: "help", args: [], rawArgs: "", options: {} };

  const [head, ...restTokens] = tokenize(trimmed);
  const candidate = head.toLowerCase() as CommandName;

  if (!KNOWN.has(candidate)) {
    // Plain mention/DM text means "send".
    return { name: "send", args: [], rawArgs: trimmed, options: {}, implicitSend: true };
  }

  const rawArgs = trimmed.slice(head.length).trim();
  const { args, options } = parseOptions(restTokens);
  return { name: candidate, args, rawArgs, options, implicitSend: false };
}

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function parseOptions(tokens: string[]): { args: string[]; options: Record<string, string | boolean> } {
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      args.push(...tokens.slice(i + 1));
      break;
    }
    if (/^-[A-Za-z]+$/.test(token) && !token.startsWith("--")) {
      for (const flag of token.slice(1)) {
        options[flag] = true;
      }
      continue;
    }
    if (!token.startsWith("--") || token === "--") {
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 2) {
      options[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = tokens[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }

  return { args, options };
}

export function optionString(cmd: ParsedCommand, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = cmd.options[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function commandTarget(cmd: ParsedCommand, ...optionNames: string[]): string {
  const positional = cmd.args.join(" ").trim();
  if (positional) return positional;
  return optionString(cmd, ...optionNames) ?? "";
}

export function hasOption(cmd: ParsedCommand, name: string): boolean {
  return cmd.options[name] === true || typeof cmd.options[name] === "string";
}

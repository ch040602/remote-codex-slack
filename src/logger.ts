export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
const current = order[configured] ?? order.info;

function write(level: LogLevel, message: string, meta?: unknown) {
  if (order[level] < current) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (meta === undefined) {
    console.error(line);
  } else {
    console.error(line, safeJson(meta));
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta)
};

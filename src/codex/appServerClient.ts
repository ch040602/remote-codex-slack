import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { logger } from "../logger.js";
import type { JsonRpcNotification, JsonRpcResponse } from "./types.js";

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export interface AppServerClientOptions {
  codexBin: string;
  requestTimeoutMs?: number;
}

export class AppServerClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRpc>();
  private initialized = false;

  constructor(private readonly options: AppServerClientOptions) {
    super();
  }

  async start() {
    if (this.proc) return;
    logger.info("starting codex app-server", { codexBin: this.options.codexBin });
    this.proc = spawn(this.options.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) logger.debug("codex app-server stderr", { text });
    });

    this.proc.on("exit", (code, signal) => {
      logger.warn("codex app-server exited", { code, signal });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`codex app-server exited before ${pending.method} completed`));
      }
      this.pending.clear();
      this.proc = undefined;
      this.initialized = false;
      this.emit("exit", { code, signal });
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await this.initialize();
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
  }

  async initialize() {
    if (this.initialized) return;
    await this.rpc("initialize", {
      clientInfo: {
        name: "codex_slack_workspace_bridge",
        title: "Codex Slack Workspace Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true
      }
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async rpc(method: string, params: unknown = {}, timeoutMs = this.options.requestTimeoutMs ?? 120_000): Promise<any> {
    if (!this.proc) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const payload = { id, method, params };
    const line = JSON.stringify(payload) + "\n";
    logger.debug("app-server rpc", { method, id });
    this.proc.stdin.write(line);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  notify(method: string, params: unknown = {}) {
    if (!this.proc) throw new Error("codex app-server is not running");
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  respond(id: string | number, result: unknown, error?: unknown) {
    if (!this.proc) return;
    const payload = error === undefined ? { id, result } : { id, error };
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (error) {
      logger.warn("invalid app-server JSON", { line, error: String(error) });
      return;
    }

    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const response = msg as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) {
        logger.debug("unmatched app-server response", response);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
      return;
    }

    if (msg.id !== undefined && msg.method) {
      // Server-initiated request. The controller may handle approvals. Default is safe decline.
      this.emit("serverRequest", msg);
      return;
    }

    if (msg.method) {
      this.emit("notification", msg as JsonRpcNotification);
      return;
    }

    logger.debug("unknown app-server message", msg);
  }
}

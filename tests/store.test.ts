import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store.js";

describe("Store pending commands", () => {
  it("adds, edits, lists, and removes pending commands by scope", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-slack-store-"));
    const store = new Store(path.join(dir, "state.json"));
    store.load();

    const pending = store.addPendingCommand({
      scopeKey: "channel:C1",
      channelId: "C1",
      command: "new",
      prompt: "fix tests",
      cwd: "C:/repo",
      createdBy: "U1"
    });

    expect(store.listPendingCommands("channel:C1").map((p) => p.prompt)).toEqual(["fix tests"]);
    store.updatePendingCommand(pending.id, { prompt: "fix lint" });
    expect(store.getPendingCommand(pending.id)?.prompt).toBe("fix lint");
    expect(store.removePendingCommand(pending.id)?.prompt).toBe("fix lint");
    expect(store.listPendingCommands("channel:C1")).toEqual([]);
  });

  it("records session command history by Slack key and Codex thread ID", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-slack-store-history-"));
    const store = new Store(path.join(dir, "state.json"));
    store.load();

    store.addSessionCommand({
      slackKey: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      codexThreadId: "019f20cf-7b8a-7c52-b037-d90afad6fd44",
      command: "send",
      prompt: "fix tests",
      cwd: "C:/repo",
      createdBy: "U1"
    });

    expect(store.listSessionCommands({ key: "C1:1.0" }).map((command) => command.prompt)).toEqual(["fix tests"]);
    expect(store.listSessionCommands({ key: "other", codexThreadId: "019f20cf-7b8a-7c52-b037-d90afad6fd44" }).map((command) => command.prompt)).toEqual(["fix tests"]);
  });

  it("removes thread bindings and their Codex lookup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-slack-store-unbind-"));
    const store = new Store(path.join(dir, "state.json"));
    store.load();

    store.upsertThreadBinding({
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "019f20cf-7b8a-7c52-b037-d90afad6fd44",
      status: "idle",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      createdBy: "U1"
    });

    expect(store.removeThreadBinding("C1:1.0")?.codexThreadId).toBe("019f20cf-7b8a-7c52-b037-d90afad6fd44");
    expect(store.getThreadBinding("C1:1.0")).toBeUndefined();
    expect(store.getThreadBindingByCodexThread("019f20cf-7b8a-7c52-b037-d90afad6fd44")).toBeUndefined();
  });

  it("persists send mode on channel and thread bindings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-slack-store-send-mode-"));
    const store = new Store(path.join(dir, "state.json"));
    store.load();

    store.setChannelBinding({
      channelId: "C1",
      cwd: "C:/repo",
      sendMode: false,
      updatedAt: "2026-07-02T00:00:00.000Z",
      updatedBy: "U1"
    });
    store.upsertThreadBinding({
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      sendMode: true,
      status: "idle",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      createdBy: "U1"
    });

    const reloaded = new Store(path.join(dir, "state.json"));
    reloaded.load();
    expect(reloaded.getChannelBinding("C1")?.sendMode).toBe(false);
    expect(reloaded.getThreadBinding("C1:1.0")?.sendMode).toBe(true);
  });
});

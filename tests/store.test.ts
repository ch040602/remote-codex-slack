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
});


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCodexCliSessions, readCodexCliSession } from "../src/codex/sessionIndex.js";

describe("Codex CLI session index", () => {
  it("reads session metadata and last messages from Codex JSONL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-index-"));
    const file = path.join(dir, "rollout-2026-07-02T12-00-00-019f20cf-7b8a-7c52-b037-d90afad6fd44.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({
        timestamp: "2026-07-02T03:00:00.000Z",
        type: "session_meta",
        payload: {
          session_id: "019f20cf-7b8a-7c52-b037-d90afad6fd44",
          timestamp: "2026-07-02T03:00:00.000Z",
          cwd: "C:/repo"
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-02T03:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "fix the tests" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-02T03:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "tests are fixed" }]
        }
      })
    ].join("\n"));

    const summary = readCodexCliSession(file);
    expect(summary?.id).toBe("019f20cf-7b8a-7c52-b037-d90afad6fd44");
    expect(summary?.cwd).toBe("C:/repo");
    expect(summary?.lastPrompt).toBe("fix the tests");
    expect(summary?.lastFinalAnswer).toBe("tests are fixed");
    expect(listCodexCliSessions({ sessionsDir: dir, limit: 1 }).map((s) => s.id)).toEqual(["019f20cf-7b8a-7c52-b037-d90afad6fd44"]);
  });
});

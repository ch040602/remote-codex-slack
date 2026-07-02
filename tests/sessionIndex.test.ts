import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCodexSessionIdsFromProcessOutput, listCodexCliSessions, readCodexCliSession } from "../src/codex/sessionIndex.js";

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
    expect(listCodexCliSessions({ sessionsDir: dir, limit: 1, detectActiveProcesses: false }).map((s) => s.id)).toEqual(["019f20cf-7b8a-7c52-b037-d90afad6fd44"]);
  });

  it("marks sessions active when the turn has started but not completed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-index-active-"));
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
        type: "event_msg",
        payload: { type: "task_started" }
      })
    ].join("\n"));

    expect(readCodexCliSession(file)?.status).toBe("active");
  });

  it("marks sessions active when an open Codex CLI process references the session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-index-process-"));
    const file = path.join(dir, "rollout-2026-07-02T12-00-00-019f20cf-7b8a-7c52-b037-d90afad6fd44.jsonl");
    fs.writeFileSync(file, JSON.stringify({
      timestamp: "2026-07-02T03:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: "019f20cf-7b8a-7c52-b037-d90afad6fd44",
        timestamp: "2026-07-02T03:00:00.000Z",
        cwd: "C:/repo"
      }
    }));

    const sessions = listCodexCliSessions({
      sessionsDir: dir,
      limit: 1,
      activeSessionIds: ["019f20cf-7b8a-7c52-b037-d90afad6fd44"],
      detectActiveProcesses: false
    });
    expect(sessions[0].status).toBe("active");
  });

  it("extracts active session IDs from Windows process command lines", () => {
    const output = [
      "CommandLine=C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd exec resume 019F20CF-7B8A-7C52-B037-D90AFAD6FD44 -",
      "CommandLine=node C:\\repo\\dist\\index.js"
    ].join("\n");

    expect([...extractCodexSessionIdsFromProcessOutput(output)]).toEqual(["019f20cf-7b8a-7c52-b037-d90afad6fd44"]);
  });

  it("deduplicates repeated JSONL files for the same session ID", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-index-dedupe-"));
    const sessionId = "019f20cf-7b8a-7c52-b037-d90afad6fd44";
    const firstFile = path.join(dir, `rollout-2026-07-02T12-00-00-${sessionId}.jsonl`);
    const secondFile = path.join(dir, `rollout-2026-07-02T13-00-00-${sessionId}.jsonl`);
    fs.writeFileSync(firstFile, JSON.stringify({
      timestamp: "2026-07-02T03:00:00.000Z",
      type: "session_meta",
      payload: { session_id: sessionId, timestamp: "2026-07-02T03:00:00.000Z", cwd: "C:/old-repo" }
    }));
    fs.writeFileSync(secondFile, JSON.stringify({
      timestamp: "2026-07-02T04:00:00.000Z",
      type: "session_meta",
      payload: { session_id: sessionId, timestamp: "2026-07-02T04:00:00.000Z", cwd: "C:/new-repo" }
    }));

    const sessions = listCodexCliSessions({ sessionsDir: dir, limit: 10, detectActiveProcesses: false });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe("C:/new-repo");
  });
});

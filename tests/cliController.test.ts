import { describe, expect, it } from "vitest";
import { buildCodexCliArgs, extractFinalAnswerFromCodexJsonEvent, normalizeSandbox } from "../src/codex/cliController.js";
import type { BridgeConfig } from "../src/config.js";

function cfg(): BridgeConfig {
  return {
    baseDirs: [],
    projects: new Map(),
    channelBindings: new Map(),
    skills: new Map(),
    defaults: {
      sandbox: "workspaceWrite",
      approvalPolicy: "never",
      model: "gpt-test"
    }
  };
}

describe("Codex CLI controller helpers", () => {
  it("builds exec args that set the working root with -C", () => {
    expect(buildCodexCliArgs({ cwd: "C:/repo", promptFromStdin: true, config: cfg() })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "C:/repo",
      "-m",
      "gpt-test",
      "-s",
      "workspace-write",
      "-a",
      "never",
      "-"
    ]);
  });

  it("builds resume args for an existing Codex CLI session", () => {
    expect(buildCodexCliArgs({ codexThreadId: "019f", cwd: "C:/repo", promptFromStdin: true, config: cfg() })).toEqual([
      "exec",
      "resume",
      "--json",
      "019f",
      "-m",
      "gpt-test",
      "-"
    ]);
  });

  it("normalizes app-server style sandbox names for the CLI", () => {
    expect(normalizeSandbox("workspaceWrite")).toBe("workspace-write");
    expect(normalizeSandbox("readOnly")).toBe("read-only");
    expect(normalizeSandbox("dangerFullAccess")).toBe("danger-full-access");
  });

  it("extracts final answers from Codex response_item assistant messages", () => {
    expect(extractFinalAnswerFromCodexJsonEvent({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "actual final answer" }
        ]
      }
    })).toBe("actual final answer");
  });

  it("extracts final answers from Codex event_msg agent messages", () => {
    expect(extractFinalAnswerFromCodexJsonEvent({
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "actual streamed answer"
      }
    })).toBe("actual streamed answer");
  });

  it("does not treat non-assistant response items as final answers", () => {
    expect(extractFinalAnswerFromCodexJsonEvent({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "user prompt" }
        ]
      }
    })).toBeUndefined();
  });
});

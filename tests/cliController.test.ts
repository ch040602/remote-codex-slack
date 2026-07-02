import { describe, expect, it } from "vitest";
import { buildCodexCliArgs, normalizeSandbox } from "../src/codex/cliController.js";
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
});


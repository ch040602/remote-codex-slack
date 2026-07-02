import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../src/core/skills.js";
import type { BridgeConfig } from "../src/config.js";

describe("SkillRegistry", () => {
  it("adds skill input items for $ references", () => {
    const cfg: BridgeConfig = {
      baseDirs: [],
      projects: new Map(),
      channelBindings: new Map(),
      defaults: { sandbox: "workspaceWrite", approvalPolicy: "never" },
      skills: new Map([
        ["example", { name: "example", path: "x", absolutePath: __filename, description: "" }]
      ])
    };
    const result = new SkillRegistry(cfg, true).buildInput("please use $example now");
    expect(result.unknownSkillNames).toEqual([]);
    expect(result.input[0]).toEqual({ type: "text", text: "please use $example now" });
    expect(result.input[1]).toMatchObject({ type: "skill", name: "example" });
  });

  it("reports unknown skills in strict mode", () => {
    const cfg: BridgeConfig = {
      baseDirs: [],
      projects: new Map(),
      channelBindings: new Map(),
      defaults: { sandbox: "workspaceWrite", approvalPolicy: "never" },
      skills: new Map()
    };
    const result = new SkillRegistry(cfg, true).buildInput("use $missing");
    expect(result.unknownSkillNames).toEqual(["missing"]);
  });

  it("embeds referenced skill files for CLI prompts", () => {
    const cfg: BridgeConfig = {
      baseDirs: [],
      projects: new Map(),
      channelBindings: new Map(),
      defaults: { sandbox: "workspaceWrite", approvalPolicy: "never" },
      skills: new Map([
        ["example", { name: "example", path: "x", absolutePath: __filename, description: "" }]
      ])
    };
    const result = new SkillRegistry(cfg, true).buildCliPrompt("please use $example now");
    expect(result.unknownSkillNames).toEqual([]);
    expect(result.referencedSkills.map((s) => s.name)).toEqual(["example"]);
    expect(result.prompt).toContain('<skill name="example"');
    expect(result.prompt).toContain("User prompt:\nplease use $example now");
  });

  it("searches and suggests configured skills", () => {
    const cfg: BridgeConfig = {
      baseDirs: [],
      projects: new Map(),
      channelBindings: new Map(),
      defaults: { sandbox: "workspaceWrite", approvalPolicy: "never" },
      skills: new Map([
        ["review", { name: "review", path: "x", absolutePath: __filename, description: "" }],
        ["test-fixer", { name: "test-fixer", path: "x", absolutePath: __filename, description: "" }]
      ])
    };
    const registry = new SkillRegistry(cfg, true);
    expect(registry.isStrict()).toBe(true);
    expect(registry.search("$rev").map((s) => s.name)).toEqual(["review"]);
    expect(registry.unknownSkillNames("use $missing")).toEqual(["missing"]);
    expect(registry.suggestionsFor("reviw").map((s) => s.name)).toContain("review");
  });
});

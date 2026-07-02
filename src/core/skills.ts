import fs from "node:fs";
import type { BridgeConfig, SkillDef } from "../config.js";

export interface CodexInputItem {
  type: "text" | "skill";
  text?: string;
  name?: string;
  path?: string;
}

export interface SkillBuildResult {
  input: CodexInputItem[];
  referencedSkills: SkillDef[];
  unknownSkillNames: string[];
}

export interface SkillPromptBuildResult {
  prompt: string;
  referencedSkills: SkillDef[];
  unknownSkillNames: string[];
}

const SKILL_TOKEN = /(^|\s)\$([A-Za-z0-9_.-]+)/g;

export class SkillRegistry {
  private sortedSkills?: SkillDef[];

  constructor(
    private readonly config: BridgeConfig,
    private readonly strict = true
  ) {}

  list(): SkillDef[] {
    this.sortedSkills ??= [...this.config.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.sortedSkills;
  }

  isStrict(): boolean {
    return this.strict;
  }

  search(prefix: string): SkillDef[] {
    const normalized = prefix.replace(/^\$/, "").toLowerCase();
    return this.list().filter((skill) => skill.name.toLowerCase().startsWith(normalized));
  }

  unknownSkillNames(text: string): string[] {
    return this.resolveReferencedSkills(text).unknownSkillNames;
  }

  suggestionsFor(name: string, limit = 5): SkillDef[] {
    const normalized = name.replace(/^\$/, "").toLowerCase();
    const skills = this.list();
    const prefix = skills.filter((skill) => skill.name.toLowerCase().startsWith(normalized));
    if (prefix.length > 0) return prefix.slice(0, limit);
    return skills
      .map((skill) => ({ skill, score: similarity(normalized, skill.name.toLowerCase()) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit)
      .map((entry) => entry.skill);
  }

  buildInput(text: string): SkillBuildResult {
    const resolved = this.resolveReferencedSkills(text);
    if (this.strict && resolved.unknownSkillNames.length > 0) {
      return { input: [], referencedSkills: [], unknownSkillNames: resolved.unknownSkillNames };
    }

    const input: CodexInputItem[] = [{ type: "text", text }];
    const unknown = new Set(resolved.unknownSkillNames);
    for (const skill of resolved.referencedSkills) {
      if (!fs.existsSync(skill.absolutePath)) {
        unknown.add(`${skill.name} (missing file: ${skill.absolutePath})`);
        continue;
      }
      input.push({ type: "skill", name: skill.name, path: skill.absolutePath });
    }

    if (this.strict && unknown.size > 0) {
      return { input: [], referencedSkills: [], unknownSkillNames: [...unknown] };
    }

    return { input, referencedSkills: resolved.referencedSkills, unknownSkillNames: [...unknown] };
  }

  buildCliPrompt(text: string): SkillPromptBuildResult {
    const resolved = this.resolveReferencedSkills(text);
    if (this.strict && resolved.unknownSkillNames.length > 0) {
      return { prompt: "", referencedSkills: [], unknownSkillNames: resolved.unknownSkillNames };
    }

    const unknown = new Set(resolved.unknownSkillNames);
    const skillBlocks: string[] = [];
    const referencedSkills: SkillDef[] = [];
    for (const skill of resolved.referencedSkills) {
      if (!fs.existsSync(skill.absolutePath)) {
        unknown.add(`${skill.name} (missing file: ${skill.absolutePath})`);
        continue;
      }
      referencedSkills.push(skill);
      const content = fs.readFileSync(skill.absolutePath, "utf8");
      skillBlocks.push(`<skill name="${skill.name}" path="${skill.absolutePath}">\n${content}\n</skill>`);
    }

    if (this.strict && unknown.size > 0) {
      return { prompt: "", referencedSkills: [], unknownSkillNames: [...unknown] };
    }

    if (skillBlocks.length === 0) {
      return { prompt: text, referencedSkills, unknownSkillNames: [...unknown] };
    }

    return {
      prompt: [
        "The user referenced the following Codex skill files with $skill syntax. Treat these as explicit task instructions when relevant.",
        "",
        ...skillBlocks,
        "",
        "User prompt:",
        text
      ].join("\n"),
      referencedSkills,
      unknownSkillNames: [...unknown]
    };
  }

  private resolveReferencedSkills(text: string): { referencedSkills: SkillDef[]; unknownSkillNames: string[] } {
    const referenced = new Map<string, SkillDef>();
    const unknown = new Set<string>();
    let match: RegExpExecArray | null;
    SKILL_TOKEN.lastIndex = 0;

    while ((match = SKILL_TOKEN.exec(text)) !== null) {
      const name = match[2];
      const skill = this.config.skills.get(name);
      if (skill) {
        referenced.set(name, skill);
      } else {
        unknown.add(name);
      }
    }

    return { referencedSkills: [...referenced.values()], unknownSkillNames: [...unknown] };
  }
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  let score = 0;
  const chars = new Set(a);
  for (const char of b) {
    if (chars.has(char)) score += 1;
  }
  return score / Math.max(a.length, b.length);
}

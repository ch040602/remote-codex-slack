import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { absoluteFromRepo, env } from "./env.js";

const ProjectSchema = z.object({
  path: z.string().min(1),
  slackChannelName: z.string().optional(),
  slackChannelId: z.string().optional(),
  default: z.boolean().optional()
});

const ProjectsFileSchema = z.object({
  baseDirs: z.array(z.string()).default([]),
  defaults: z
    .object({
      sandbox: z.string().optional(),
      approvalPolicy: z.string().optional(),
      model: z.string().optional(),
      reasoningEffort: z.string().optional()
    })
    .default({}),
  projects: z.record(ProjectSchema).default({}),
  channelBindings: z.record(z.string()).default({})
});

const SkillSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional()
});

const SkillsFileSchema = z.object({
  skills: z.record(SkillSchema).default({})
});

export interface ProjectDef {
  name: string;
  path: string;
  absolutePath: string;
  slackChannelName?: string;
  slackChannelId?: string;
  default?: boolean;
}

export interface SkillDef {
  name: string;
  path: string;
  absolutePath: string;
  description?: string;
}

export interface BridgeConfig {
  baseDirs: string[];
  projects: Map<string, ProjectDef>;
  skills: Map<string, SkillDef>;
  channelBindings: Map<string, string>;
  defaults: {
    sandbox: string;
    approvalPolicy: string;
    model?: string;
    reasoningEffort?: string;
  };
  defaultProjectName?: string;
}

export function loadConfig(): BridgeConfig {
  const projectsPath = absoluteFromRepo(env.projectsConfig);
  const skillsPath = absoluteFromRepo(env.skillsConfig);

  const projectsRaw = readYamlOrEmpty(projectsPath);
  const skillsRaw = readYamlOrEmpty(skillsPath);

  const projectsFile = ProjectsFileSchema.parse(projectsRaw);
  const skillsFile = SkillsFileSchema.parse(skillsRaw);

  const baseDirs = projectsFile.baseDirs.map((p) => normalizePath(resolveUserPath(p)));
  const firstBaseDir = baseDirs[0] ?? process.cwd();
  const projects = new Map<string, ProjectDef>();

  let defaultProjectName: string | undefined;
  for (const [name, project] of Object.entries(projectsFile.projects)) {
    const absolutePath = normalizePath(resolveProjectPath(project.path, firstBaseDir));
    projects.set(name, {
      name,
      path: project.path,
      absolutePath,
      slackChannelName: project.slackChannelName,
      slackChannelId: project.slackChannelId,
      default: project.default
    });
    if (project.default || !defaultProjectName) defaultProjectName = name;
  }

  const skills = new Map<string, SkillDef>();
  for (const [name, skill] of Object.entries(skillsFile.skills)) {
    const absolutePath = normalizePath(resolveRelativeToFile(skill.path, path.dirname(skillsPath)));
    skills.set(name, { name, path: skill.path, absolutePath, description: skill.description });
  }

  const channelBindings = new Map<string, string>();
  for (const [channelId, projectName] of Object.entries(projectsFile.channelBindings)) {
    channelBindings.set(channelId, projectName);
  }
  for (const project of projects.values()) {
    if (project.slackChannelId) channelBindings.set(project.slackChannelId, project.name);
  }

  return {
    baseDirs,
    projects,
    skills,
    channelBindings,
    defaultProjectName,
    defaults: {
      sandbox: projectsFile.defaults.sandbox || env.codexSandbox,
      approvalPolicy: projectsFile.defaults.approvalPolicy || env.codexApprovalPolicy,
      model: projectsFile.defaults.model || env.codexModel || undefined,
      reasoningEffort: projectsFile.defaults.reasoningEffort || env.codexReasoningEffort || undefined
    }
  };
}

function readYamlOrEmpty(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  return yaml.load(content) ?? {};
}

export function resolveUserPath(input: string): string {
  let value = input.trim();
  if (value.startsWith("~/") || value === "~") {
    value = path.join(os.homedir(), value.slice(2));
  }
  value = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, key) => process.env[key] ?? "");
  value = value.replace(/%([A-Z0-9_]+)%/gi, (_, key) => process.env[key] ?? "");
  return path.resolve(value);
}

function resolveProjectPath(projectPath: string, baseDir: string): string {
  const expanded = resolveUserPath(projectPath);
  // resolveUserPath makes relative values absolute against process.cwd(); detect original relative explicitly.
  if (!path.isAbsolute(projectPath.replace(/^~($|[\\/])/, os.homedir()))) {
    return path.resolve(baseDir, projectPath);
  }
  return expanded;
}

function resolveRelativeToFile(input: string, fileDir: string): string {
  if (input.startsWith("~/") || input === "~" || path.isAbsolute(input)) return resolveUserPath(input);
  return path.resolve(fileDir, input);
}

export function normalizePath(p: string): string {
  return path.resolve(p);
}

export function isPathInside(child: string, parent: string): boolean {
  const resolvedChild = normalizeForCompare(child);
  const resolvedParent = normalizeForCompare(parent);
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

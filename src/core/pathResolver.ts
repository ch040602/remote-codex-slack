import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig, ProjectDef } from "../config.js";
import { isPathInside, normalizePath, resolveUserPath } from "../config.js";

export interface ResolvedWorkspace {
  cwd: string;
  projectName?: string;
  project?: ProjectDef;
}

export class PathResolver {
  constructor(private readonly config: BridgeConfig) {}

  defaultWorkspace(): ResolvedWorkspace {
    if (this.config.defaultProjectName) {
      return this.resolve(this.config.defaultProjectName);
    }
    const base = this.config.baseDirs[0] ?? process.cwd();
    return { cwd: base };
  }

  resolve(input: string, relativeTo?: string): ResolvedWorkspace {
    const token = input.trim();
    if (!token) return this.defaultWorkspace();

    const project = this.config.projects.get(token);
    if (project) {
      this.assertAllowed(project.absolutePath);
      return { cwd: project.absolutePath, projectName: project.name, project };
    }

    const candidate = path.isAbsolute(token)
      ? resolveUserPath(token)
      : path.resolve(relativeTo ?? this.config.baseDirs[0] ?? process.cwd(), token);
    const normalized = normalizePath(candidate);
    this.assertAllowed(normalized);
    return { cwd: normalized };
  }

  resolveProjectForChannel(channelId: string): ResolvedWorkspace | undefined {
    const projectName = this.config.channelBindings.get(channelId);
    if (!projectName) return undefined;
    return this.resolve(projectName);
  }

  assertAllowed(cwd: string) {
    const roots = this.config.baseDirs;
    if (roots.length === 0) return;
    if (!roots.some((root) => isPathInside(cwd, root))) {
      throw new Error(`Workspace is outside allowed baseDirs: ${cwd}`);
    }
  }

  ensureExists(cwd: string) {
    if (!fs.existsSync(cwd)) {
      throw new Error(`Workspace does not exist: ${cwd}`);
    }
  }
}

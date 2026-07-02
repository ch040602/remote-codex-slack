import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

dotenv.config();

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackAppToken: process.env.SLACK_APP_TOKEN ?? "",
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  allowedSlackUserIds: parseCsv(process.env.ALLOWED_SLACK_USER_IDS),
  allowAllSlackUsers: bool(process.env.ALLOW_ALL_SLACK_USERS, false),
  commandPrefix: process.env.SLACK_COMMAND_PREFIX ?? "!codex",
  navigationRoot: process.env.CODEX_NAV_ROOT ?? path.join(os.homedir(), "Desktop"),
  codexDriver: process.env.CODEX_DRIVER ?? "cli",
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexSessionsDir: process.env.CODEX_SESSIONS_DIR ?? path.join(os.homedir(), ".codex", "sessions"),
  codexModel: process.env.CODEX_MODEL ?? "",
  codexSandbox: process.env.CODEX_SANDBOX ?? "workspaceWrite",
  codexApprovalPolicy: process.env.CODEX_APPROVAL_POLICY ?? "never",
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "",
  projectsConfig: process.env.PROJECTS_CONFIG ?? "./config/projects.yaml",
  skillsConfig: process.env.SKILLS_CONFIG ?? "./config/skills.yaml",
  statePath: process.env.STATE_PATH ?? "./data/state.json",
  slackMaxMessageChars: int(process.env.SLACK_MAX_MESSAGE_CHARS, 3500),
  strictSkillReferences: bool(process.env.STRICT_SKILL_REFERENCES, true),
  defaultInviteUserIds: parseCsv(process.env.DEFAULT_INVITE_USER_IDS),
  createPrivateChannels: bool(process.env.CREATE_PRIVATE_CHANNELS, false)
};

export function assertRequiredEnv() {
  const missing: string[] = [];
  if (!env.slackBotToken) missing.push("SLACK_BOT_TOKEN");
  if (!env.slackAppToken) missing.push("SLACK_APP_TOKEN");
  if (!env.allowAllSlackUsers && env.allowedSlackUserIds.length === 0) {
    missing.push("ALLOWED_SLACK_USER_IDS or ALLOW_ALL_SLACK_USERS=1");
  }
  if (missing.length) {
    throw new Error(`Missing required environment: ${missing.join(", ")}`);
  }
}

export function absoluteFromRepo(relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(process.cwd(), relativeOrAbsolute);
}

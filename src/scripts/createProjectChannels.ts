import { WebClient } from "@slack/web-api";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { env, assertRequiredEnv } from "../env.js";
import { loadConfig } from "../config.js";
import type { ProjectDef } from "../config.js";
import { Store } from "../core/store.js";
import { logger } from "../logger.js";

interface ResolvedChannel {
  channelId?: string;
  channelName: string;
  bindDefaultProject: boolean;
  mergedWithProject?: string;
}

async function main() {
  assertRequiredEnv();
  const config = loadConfig();
  const client = new WebClient(env.slackBotToken);
  const store = new Store(env.statePath);
  store.load();
  const claimedChannelNames = new Map<string, { projectName: string; channelId?: string }>();
  const rl = readline.createInterface({ input, output });

  try {
    for (const project of config.projects.values()) {
      const desiredChannelName = channelNameForProject(project);
      const resolved = await resolveChannelName(client, rl, claimedChannelNames, project, desiredChannelName);
      const channelName = resolved.channelName;
      let channelId = resolved.channelId;

      if (!channelId) {
        const created = await client.conversations.create({
          name: channelName,
          is_private: env.createPrivateChannels
        });
        channelId = created.channel?.id;
        if (!channelId) throw new Error(`Slack did not return id for #${channelName}`);
        logger.info("created Slack channel", { channelName, channelId });
      } else {
        logger.info("using Slack channel", { channelName, channelId, mergedWithProject: resolved.mergedWithProject });
      }

      claimedChannelNames.set(channelName, { projectName: project.name, channelId });

      if (env.defaultInviteUserIds.length > 0) {
        try {
          await client.conversations.invite({ channel: channelId, users: env.defaultInviteUserIds.join(",") });
        } catch (error) {
          logger.warn("invite failed; continuing", { channelName, error: String(error) });
        }
      }

      if (resolved.bindDefaultProject) {
        store.setChannelBinding({
          channelId,
          projectName: project.name,
          cwd: project.absolutePath,
          updatedAt: new Date().toISOString(),
          updatedBy: "bootstrap"
        });
      } else {
        logger.info("merged project into existing channel without changing default binding", {
          channelName,
          projectName: project.name,
          cwd: project.absolutePath
        });
      }
    }
  } finally {
    rl.close();
  }

  const statePath = path.resolve(env.statePath);
  if (fs.existsSync(statePath)) {
    logger.info("updated channel bindings", { statePath });
  }
}

export function channelNameForProject(project: ProjectDef): string {
  return normalizeChannelName(project.slackChannelName || path.basename(project.absolutePath));
}

export function normalizeChannelName(name: string) {
  return name.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80);
}

async function resolveChannelName(
  client: WebClient,
  rl: readline.Interface,
  claimedChannelNames: Map<string, { projectName: string; channelId?: string }>,
  project: ProjectDef,
  desiredChannelName: string
): Promise<ResolvedChannel> {
  const claimed = claimedChannelNames.get(desiredChannelName);
  if (claimed) {
    const choice = await askConflict(rl, `#${desiredChannelName} is already assigned to project ${claimed.projectName}. Project ${project.name} also maps to that folder channel name.`);
    if (choice === "merge") {
      return {
        channelName: desiredChannelName,
        channelId: claimed.channelId,
        bindDefaultProject: false,
        mergedWithProject: claimed.projectName
      };
    }
    const suffixed = await nextAvailableChannelName(client, claimedChannelNames, desiredChannelName);
    return { channelName: suffixed, bindDefaultProject: true };
  }

  const existing = await findChannel(client, desiredChannelName);
  if (!existing?.id) {
    return { channelName: desiredChannelName, bindDefaultProject: true };
  }

  const choice = await askConflict(rl, `#${desiredChannelName} already exists in Slack.`);
  if (choice === "merge") {
    return { channelName: desiredChannelName, channelId: existing.id, bindDefaultProject: true };
  }
  const suffixed = await nextAvailableChannelName(client, claimedChannelNames, desiredChannelName);
  return { channelName: suffixed, bindDefaultProject: true };
}

async function askConflict(rl: readline.Interface, message: string): Promise<"merge" | "suffix"> {
  if (!process.stdin.isTTY) {
    throw new Error(`${message} Re-run npm run channels:create in an interactive terminal and choose merge or suffix.`);
  }

  while (true) {
    const answer = (await rl.question(`${message}\nChoose [m]erge existing channel or create [s]uffixed channel (-2): `)).trim().toLowerCase();
    if (["m", "merge"].includes(answer)) return "merge";
    if (["s", "suffix", "new", "2", "-2"].includes(answer)) return "suffix";
    output.write("Please answer merge or suffix.\n");
  }
}

async function nextAvailableChannelName(client: WebClient, claimedChannelNames: Map<string, unknown>, baseName: string): Promise<string> {
  for (let index = 2; index < 100; index++) {
    const candidate = normalizeChannelName(`${baseName}-${index}`);
    if (claimedChannelNames.has(candidate)) continue;
    const existing = await findChannel(client, candidate);
    if (!existing?.id) return candidate;
  }
  throw new Error(`Could not find an available suffixed channel name for #${baseName}`);
}

async function findChannel(client: WebClient, name: string): Promise<{ id?: string; name?: string } | undefined> {
  let cursor: string | undefined;
  do {
    const page = await client.conversations.list({
      exclude_archived: true,
      limit: 200,
      cursor,
      types: "public_channel,private_channel"
    });
    const found = page.channels?.find((c) => c.name === name);
    if (found) return found;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logger.error("channel bootstrap failed", { error: error instanceof Error ? error.stack : String(error) });
    process.exit(1);
  });
}

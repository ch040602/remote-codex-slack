import { assertRequiredEnv, env } from "./env.js";
import { loadConfig } from "./config.js";
import { Store } from "./core/store.js";
import { PathResolver } from "./core/pathResolver.js";
import { SkillRegistry } from "./core/skills.js";
import { AppServerClient } from "./codex/appServerClient.js";
import { CodexController } from "./codex/codexController.js";
import { CodexCliController } from "./codex/cliController.js";
import type { CodexRuntime } from "./codex/controllerTypes.js";
import { SlackBridge } from "./slack/slackBridge.js";
import { logger } from "./logger.js";

async function main() {
  assertRequiredEnv();
  const config = loadConfig();
  const store = new Store(env.statePath);
  store.load();

  const paths = new PathResolver(config);
  const skills = new SkillRegistry(config, env.strictSkillReferences);
  const appServer = env.codexDriver === "app-server" ? new AppServerClient({ codexBin: env.codexBin }) : undefined;
  const codex: CodexRuntime =
    env.codexDriver === "app-server"
      ? new CodexController(appServer!, store, config, skills)
      : new CodexCliController(env.codexBin, store, config, skills);
  const slack = new SlackBridge(config, store, paths, skills, codex);

  await codex.start();
  await slack.start();

  process.on("SIGINT", async () => {
    logger.info("SIGINT received; stopping");
    await appServer?.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received; stopping");
    await appServer?.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("fatal", { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});

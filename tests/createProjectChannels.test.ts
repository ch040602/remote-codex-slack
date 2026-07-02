import { describe, expect, it } from "vitest";
import { channelNameForProject, normalizeChannelName } from "../src/scripts/createProjectChannels.js";
import type { ProjectDef } from "../src/config.js";

function project(path: string, slackChannelName?: string): ProjectDef {
  return {
    name: "p",
    path,
    absolutePath: path,
    slackChannelName
  };
}

describe("project channel bootstrap naming", () => {
  it("uses the project folder basename when no Slack channel override is set", () => {
    expect(channelNameForProject(project("C:/work/api-server"))).toBe("api-server");
  });

  it("uses explicit Slack channel names when configured", () => {
    expect(channelNameForProject(project("C:/work/api-server", "codex-api"))).toBe("codex-api");
  });

  it("normalizes Slack channel names", () => {
    expect(normalizeChannelName("#My Project!")).toBe("my-project-");
  });
});


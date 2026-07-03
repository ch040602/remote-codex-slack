import { describe, expect, it } from "vitest";
import type { SlackThreadBinding } from "../src/core/store.js";
import { slackBridgeTestInternals } from "../src/slack/slackBridge.js";

describe("Slack bridge block generation", () => {
  it("keeps bind-session picker section text within Slack limits", () => {
    const longResponse = "finished ".repeat(1000);
    const sessions: SlackThreadBinding[] = Array.from({ length: 10 }, (_, index) => ({
      key: `codex-cli:019f20cf-7b8a-7c52-b037-d90afad6fd${String(index).padStart(2, "0")}`,
      channelId: "",
      threadTs: "",
      cwd: `C:/Users/example/Documents/very-long-workspace-${index}`.repeat(3),
      codexThreadId: `019f20cf-7b8a-7c52-b037-d90afad6fd${String(index).padStart(2, "0")}`,
      status: "idle",
      lastPrompt: "fix the Slack session binding",
      lastFinalAnswer: longResponse,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      createdBy: "codex-cli"
    }));
    const longText = sessions
      .map((session, index) => `${index + 1}. ${session.cwd}\n${session.lastFinalAnswer}`)
      .join("\n");

    const blocks = slackBridgeTestInternals.bindSessionPickerBlocks(sessions, "en", longText);
    const sectionText = blocks[0].text.text;
    const options = blocks[1].elements[0].options;

    expect(sectionText.length).toBeLessThanOrEqual(2900);
    expect(options).toHaveLength(10);
    expect(options.every((option: any) => option.text.text.length >= 1 && option.text.text.length <= 75)).toBe(true);
    expect(options.every((option: any) => option.description.text.length >= 1 && option.description.text.length <= 75)).toBe(true);
    expect(options.every((option: any) => option.value.length >= 1 && option.value.length <= 150)).toBe(true);
  });

  it("truncates generic Slack section text safely", () => {
    expect(slackBridgeTestInternals.slackSectionText("x".repeat(4000))).toHaveLength(2900);
    expect(slackBridgeTestInternals.slackSectionText("")).toBe("(empty)");
  });

  it("does not render an empty static select", () => {
    const blocks = slackBridgeTestInternals.bindSessionPickerBlocks([], "en", "");

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.text).toBe("(empty)");
  });
});

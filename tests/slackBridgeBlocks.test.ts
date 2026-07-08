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

  it("uses unique action ids inside send-policy actions blocks", () => {
    const blocks = slackBridgeTestInternals.sendPolicyChoiceBlocks("en", "Change send policy?");
    const actions = blocks.find((block: any) => block.type === "actions");
    const ids = actions.elements.map((element: any) => element.action_id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults newly linked sessions to immediate sends", () => {
    expect(slackBridgeTestInternals.defaultLinkedSendPolicy).toBe("immediate");
  });

  it("marks the immediate send-policy action as primary when immediate is active", () => {
    const blocks = slackBridgeTestInternals.sendPolicyChoiceBlocks("en", "Change send policy?", "immediate");
    const actions = blocks.find((block: any) => block.type === "actions");
    const [immediate, confirm, pending] = actions.elements;

    expect(immediate.style).toBe("primary");
    expect(confirm.style).toBeUndefined();
    expect(pending.style).toBeUndefined();
  });

  it("renders turn-started messages as working status updates", () => {
    const text = slackBridgeTestInternals.renderTurnStartedMessage({
      turnId: "turn-1",
      cwd: "C:/repo",
      sendPolicy: "immediate",
      createdBinding: true,
      referencedSkillNames: ["review-driven-development"]
    });

    expect(text).toContain("Codex is working");
    expect(text).toContain("turn-1");
    expect(text).toContain("send policy: `immediate`");
    expect(text).toContain("$review-driven-development");
    expect(text).toContain("A completion message will be posted here.");
  });

  it("renders completed and failed turn messages clearly", () => {
    const completed = slackBridgeTestInternals.renderTurnCompletedMessage({
      slackKey: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      codexThreadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finalAnswer: "done"
    });
    const failed = slackBridgeTestInternals.renderTurnCompletedMessage({
      slackKey: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      codexThreadId: "thread-1",
      turnId: "turn-2",
      status: "failed",
      finalAnswer: "failed",
      errorMessage: "boom"
    });

    expect(completed).toContain("Codex completed");
    expect(completed).toContain("done");
    expect(failed).toContain("Codex failed");
    expect(failed).toContain("error: boom");
  });

  it("broadcasts completion replies to the channel while keeping non-thread posts normal", () => {
    expect(slackBridgeTestInternals.threadPostMessageParams("C1", "1.0", "done", true)).toEqual({
      channel: "C1",
      thread_ts: "1.0",
      text: "done",
      reply_broadcast: true
    });
    expect(slackBridgeTestInternals.threadPostMessageParams("C1", undefined, "done", true)).toEqual({
      channel: "C1",
      thread_ts: undefined,
      text: "done"
    });
  });

  it("queues send input against the active session scope instead of running immediately", () => {
    const active: SlackThreadBinding = {
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "thread-1",
      activeTurnId: "turn-1",
      status: "active",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      createdBy: "U1"
    };

    expect(slackBridgeTestInternals.activeSendQueueTarget(undefined, active, false)).toEqual({
      scopeKey: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0"
    });
    expect(slackBridgeTestInternals.activeSendQueueTarget(active, undefined, true)).toBeUndefined();
    expect(slackBridgeTestInternals.activeSendQueueTarget({ ...active, status: "idle", activeTurnId: undefined }, undefined, false)).toBeUndefined();
  });

  it("detects new final answers from externally updated CLI sessions", () => {
    const binding: SlackThreadBinding = {
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "thread-1",
      activeTurnId: "external-cli:thread-1",
      status: "active",
      lastFinalAnswer: "old answer",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      createdBy: "U1"
    };

    const update = slackBridgeTestInternals.externalCliSessionSyncUpdate(binding, {
      id: "thread-1",
      cwd: "C:/repo",
      status: "idle",
      turnActive: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:01:00.000Z",
      path: "C:/Users/example/.codex/sessions/thread-1.jsonl",
      lastPrompt: "run from cli",
      lastFinalAnswer: "new answer",
      commands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }]
    });

    expect(update).toEqual({
      patch: {
        status: "completed",
        activeTurnId: undefined,
        lastPrompt: "run from cli",
        lastFinalAnswer: "new answer",
        sessionCommands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }],
        updatedAt: "2026-07-07T00:01:00.000Z"
      },
      completion: {
        slackKey: "C1:1.0",
        channelId: "C1",
        threadTs: "1.0",
        codexThreadId: "thread-1",
        turnId: "external-cli:thread-1",
        status: "completed",
        finalAnswer: "new answer"
      }
    });
  });

  it("posts final external CLI answers when the CLI process remains active after turn completion", () => {
    const binding: SlackThreadBinding = {
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "thread-1",
      activeTurnId: "external-cli:thread-1",
      status: "active",
      lastFinalAnswer: "old answer",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      createdBy: "U1"
    };

    const update = slackBridgeTestInternals.externalCliSessionSyncUpdate(binding, {
      id: "thread-1",
      cwd: "C:/repo",
      status: "active",
      turnActive: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:01:00.000Z",
      path: "C:/Users/example/.codex/sessions/thread-1.jsonl",
      lastPrompt: "run from cli",
      lastFinalAnswer: "new active-process answer",
      commands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }]
    });

    expect(update?.patch).toMatchObject({
      lastPrompt: "run from cli",
      lastFinalAnswer: "new active-process answer",
      sessionCommands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }],
      updatedAt: "2026-07-07T00:01:00.000Z"
    });
    expect(update?.completion).toMatchObject({
      slackKey: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      codexThreadId: "thread-1",
      turnId: "external-cli:thread-1",
      status: "active",
      finalAnswer: "new active-process answer"
    });
  });

  it("does not post external CLI assistant messages before the turn completes", () => {
    const binding: SlackThreadBinding = {
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "thread-1",
      activeTurnId: "external-cli:thread-1",
      status: "active",
      lastFinalAnswer: "old answer",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      createdBy: "U1"
    };

    const update = slackBridgeTestInternals.externalCliSessionSyncUpdate(binding, {
      id: "thread-1",
      cwd: "C:/repo",
      status: "active",
      turnActive: true,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:01:00.000Z",
      path: "C:/Users/example/.codex/sessions/thread-1.jsonl",
      lastPrompt: "run from cli",
      lastFinalAnswer: "partial in-progress answer",
      commands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }]
    });

    expect(update?.patch).toMatchObject({
      lastPrompt: "run from cli",
      lastFinalAnswer: "partial in-progress answer",
      sessionCommands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }],
      updatedAt: "2026-07-07T00:01:00.000Z"
    });
    expect(update?.completion).toBeUndefined();
  });

  it("can post external CLI assistant messages before completion in answer-updates mode", () => {
    const binding: SlackThreadBinding = {
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "thread-1",
      activeTurnId: "external-cli:thread-1",
      status: "active",
      notifyMode: "answer-updates",
      lastFinalAnswer: "old answer",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      createdBy: "U1"
    };

    const update = slackBridgeTestInternals.externalCliSessionSyncUpdate(binding, {
      id: "thread-1",
      cwd: "C:/repo",
      status: "active",
      turnActive: true,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:01:00.000Z",
      path: "C:/Users/example/.codex/sessions/thread-1.jsonl",
      lastPrompt: "run from cli",
      lastFinalAnswer: "in-progress answer update",
      commands: [{ timestamp: "2026-07-07T00:00:30.000Z", prompt: "run from cli" }]
    });

    expect(update?.completion).toMatchObject({
      slackKey: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      codexThreadId: "thread-1",
      turnId: "external-cli:thread-1",
      status: "active",
      finalAnswer: "in-progress answer update"
    });
  });

  it("does not duplicate Slack-managed CLI completion messages", () => {
    const binding: SlackThreadBinding = {
      key: "C1:1.0",
      channelId: "C1",
      threadTs: "1.0",
      cwd: "C:/repo",
      codexThreadId: "thread-1",
      activeTurnId: "cli-turn-1",
      status: "active",
      lastFinalAnswer: "old answer",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      createdBy: "U1"
    };

    const update = slackBridgeTestInternals.externalCliSessionSyncUpdate(binding, {
      id: "thread-1",
      cwd: "C:/repo",
      status: "idle",
      turnActive: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:01:00.000Z",
      path: "C:/Users/example/.codex/sessions/thread-1.jsonl",
      lastFinalAnswer: "new answer",
      commands: []
    });

    expect(update).toBeUndefined();
  });
});

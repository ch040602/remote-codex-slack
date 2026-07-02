import { describe, expect, it } from "vitest";
import { commandTarget, isPlainSlackChannelMessage, normalizeSlackMessageText, parseCommand, stripPrefix, tokenize } from "../src/commands/parser.js";

describe("command parser", () => {
  it("tokenizes quoted args", () => {
    expect(tokenize('new api "fix tests"')).toEqual(["new", "api", "fix tests"]);
  });

  it("parses options", () => {
    const cmd = parseCommand('new --cwd api "fix tests"');
    expect(cmd.name).toBe("new");
    expect(cmd.options.cwd).toBe("api");
    expect(cmd.args).toEqual(["fix tests"]);
  });

  it("treats unknown leading text as send", () => {
    const cmd = parseCommand("fix the bug");
    expect(cmd.name).toBe("send");
    expect(cmd.rawArgs).toBe("fix the bug");

    const skill = parseCommand("$review fix the bug");
    expect(skill.name).toBe("send");
    expect(skill.rawArgs).toBe("$review fix the bug");
  });

  it("strips command prefix", () => {
    expect(stripPrefix("!codex pwd", "!codex")).toBe("pwd");
  });

  it("uses option values as command targets when there are no positional args", () => {
    const cmd = parseCommand("use --channel api");
    expect(cmd.args).toEqual([]);
    expect(cmd.options.channel).toBe("api");
    expect(commandTarget(cmd, "channel")).toBe("api");
  });

  it("parses recent session commands", () => {
    expect(parseCommand("recent").name).toBe("recent");
    expect(parseCommand("active --channel repo 1").name).toBe("active");
    expect(parseCommand("session").name).toBe("session");
    expect(parseCommand("s").name).toBe("s");
    expect(parseCommand("send-mode off").name).toBe("send-mode");
    expect(parseCommand("send-mode off").args).toEqual(["off"]);
    expect(parseCommand("send-policy confirm").name).toBe("send-policy");
    expect(parseCommand("send-policy pending").args).toEqual(["pending"]);
    expect(parseCommand("bind-session 2").name).toBe("bind-session");
    expect(parseCommand(["bind", "channel api"].join("-")).name).toBe("send");
    expect(parseCommand("unbind-session").name).toBe("unbind-session");
    expect(parseCommand("history 2").name).toBe("history");
    const rerunCommand = parseCommand("rerun-command 3 2");
    expect(rerunCommand.name).toBe("rerun-command");
    expect(rerunCommand.args).toEqual(["3", "2"]);
    expect(parseCommand("resume 2 continue work").args).toEqual(["2", "continue", "work"]);
    const rerun = parseCommand("rerun-session 2 fix lint");
    expect(rerun.name).toBe("rerun-session");
    expect(rerun.args).toEqual(["2", "fix", "lint"]);
  });

  it("parses language commands", () => {
    expect(parseCommand("language ko").name).toBe("language");
    expect(parseCommand("lang en").name).toBe("lang");
    expect(parseCommand("언어 ko").name).toBe("언어");
  });

  it("parses command suggestion lookup", () => {
    const cmd = parseCommand("commands pend");
    expect(cmd.name).toBe("commands");
    expect(cmd.args).toEqual(["pend"]);
  });

  it("parses force flags without consuming prompt text", () => {
    const short = parseCommand("send -f fix tests");
    expect(short.options.f).toBe(true);
    expect(short.args).toEqual(["fix", "tests"]);

    const long = parseCommand("send --force fix tests");
    expect(long.options.force).toBe(true);
    expect(long.args).toEqual(["fix", "tests"]);

    const rerunHistory = parseCommand("rerun-command -f 3 2");
    expect(rerunHistory.name).toBe("rerun-command");
    expect(rerunHistory.options.f).toBe(true);
    expect(rerunHistory.args).toEqual(["3", "2"]);
  });

  it("parses pending queue commands", () => {
    expect(parseCommand("pending").name).toBe("pending");
    expect(parseCommand("pending-edit 1 new prompt").name).toBe("pending-edit");
    expect(parseCommand("pending-drop 1").name).toBe("pending-drop");
    expect(parseCommand("pending-run all").name).toBe("pending-run");
  });

  it("parses workspace browsing commands", () => {
    expect(parseCommand("ls").name).toBe("ls");
    expect(parseCommand("ls src").args).toEqual(["src"]);
    const recent = parseCommand("recent --channel api-copy 2");
    expect(recent.name).toBe("recent");
    expect(recent.options.channel).toBe("api-copy");
    expect(recent.args).toEqual(["2"]);
  });

  it("normalizes Slack channel messages into Codex send commands", () => {
    expect(normalizeSlackMessageText("pwd", "!codex", false)).toBe("send pwd");
    expect(normalizeSlackMessageText("$review inspect", "!codex", false)).toBe("send $review inspect");
    expect(normalizeSlackMessageText("!codex pwd", "!codex", false)).toBe("pwd");
    expect(normalizeSlackMessageText("/codex pwd", "!codex", false)).toBeUndefined();
    expect(normalizeSlackMessageText("/codex pwd", "!codex", true)).toBeUndefined();
    expect(isPlainSlackChannelMessage("s", "!codex", false)).toBe(true);
    expect(isPlainSlackChannelMessage("pwd", "!codex", false)).toBe(true);
    expect(isPlainSlackChannelMessage("!codex pwd", "!codex", false)).toBe(false);
    expect(isPlainSlackChannelMessage("/codex pwd", "!codex", false)).toBe(false);
  });
});

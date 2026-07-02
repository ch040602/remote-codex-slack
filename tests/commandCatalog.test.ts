import { describe, expect, it } from "vitest";
import { commandSuggestions, hasCommandSuggestion, renderCommandSuggestions } from "../src/commands/catalog.js";

describe("command suggestions", () => {
  it("suggests commands by prefix", () => {
    expect(commandSuggestions("pend").map((suggestion) => suggestion.entry.name)).toContain("pending");
    expect(commandSuggestions("rerun-s").map((suggestion) => suggestion.entry.name)).toContain("rerun-session");
    expect(commandSuggestions("hist").map((suggestion) => suggestion.entry.name)).toContain("history");
    expect(commandSuggestions("active").map((suggestion) => suggestion.entry.name)).toContain("active");
    expect(commandSuggestions("s").map((suggestion) => suggestion.entry.name)).toContain("session");
    expect(commandSuggestions("send-m").map((suggestion) => suggestion.entry.name)).toContain("send-mode");
    expect(commandSuggestions("unbind-s").map((suggestion) => suggestion.entry.name)).toContain("unbind-session");
  });

  it("suggests commands by small typos", () => {
    expect(commandSuggestions("statu").map((suggestion) => suggestion.entry.name)).toContain("status");
    expect(hasCommandSuggestion("statu")).toBe(true);
  });

  it("renders suggestions in the selected language", () => {
    const rendered = renderCommandSuggestions("pend", "ko", "!codex");
    expect(rendered).toContain("명령어 추천");
    expect(rendered).toContain("대기 중인 명령");
  });
});

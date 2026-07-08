import type { LanguageCode } from "../core/store.js";

export interface CommandHelpEntry {
  name: string;
  usage: string;
  en: string;
  ko: string;
  aliases?: string[];
}

export interface CommandSuggestion {
  entry: CommandHelpEntry;
  score: number;
  reason: "exact" | "prefix" | "contains" | "fuzzy";
}

export const COMMAND_HELP: CommandHelpEntry[] = [
  { name: "help", usage: "help", en: "Show the full command reference.", ko: "전체 명령어 도움말을 봅니다." },
  { name: "commands", usage: "commands [prefix]", en: "Search command suggestions.", ko: "명령어 추천을 검색합니다.", aliases: ["?"] },
  { name: "language", usage: "language en|ko", en: "Change bot help/status language.", ko: "봇 안내 언어를 영어/한국어로 바꿉니다.", aliases: ["lang", "언어"] },
  { name: "projects", usage: "projects", en: "Show configured projects.", ko: "설정된 project 목록을 봅니다." },
  { name: "skills", usage: "skills [prefix]", en: "Show configured skills or prefix matches.", ko: "설정된 skill 목록이나 prefix 검색 결과를 봅니다." },
  { name: "$", usage: "$ or $prefix", en: "Look up configured skills.", ko: "설정된 skill을 조회합니다." },
  { name: "pwd", usage: "pwd", en: "Show the current workspace.", ko: "현재 작업공간을 봅니다." },
  { name: "ls", usage: "ls [path]", en: "List files/folders in the current workspace.", ko: "현재 작업공간의 파일/폴더를 봅니다." },
  { name: "cd", usage: "cd <project|path>", en: "Set the workspace for this thread or channel.", ko: "현재 thread 또는 channel의 작업공간을 설정합니다.", aliases: ["use"] },
  { name: "bind-session", usage: "bind-session [number|codexThreadId|last]", en: "Bind this channel/thread to a recent Codex session.", ko: "현재 channel/thread를 최근 Codex 세션에 연결합니다." },
  { name: "session", usage: "session", en: "Open quick session actions for this repo/channel.", ko: "현재 repo/channel의 빠른 세션 작업 메뉴를 엽니다.", aliases: ["s"] },
  { name: "unbind-session", usage: "unbind-session", en: "Remove the current session binding.", ko: "현재 세션 연결을 해제합니다." },
  { name: "new", usage: "new [-f] [--cwd path] <prompt>", en: "Start, confirm, or queue a new Codex session by send policy.", ko: "send policy에 따라 새 Codex 세션을 시작, 확인, 또는 대기열에 넣습니다." },
  { name: "send", usage: "send [-f] <prompt>", en: "Send, confirm, or queue input to the current session by send policy.", ko: "send policy에 따라 현재 세션 입력을 전송, 확인, 또는 대기열에 넣습니다." },
  { name: "send-mode", usage: "send-mode on|off|status", en: "Toggle whether normal chat messages are accepted as Codex input.", ko: "일반 채팅 메시지를 Codex 입력으로 받을지 켜고 끕니다." },
  { name: "send-policy", usage: "send-policy immediate|confirm|pending|status", en: "Choose immediate, button-confirmed, or queued execution.", ko: "즉시 실행, 버튼 확인, 전체 대기열 모드 중 선택합니다." },
  { name: "notify-mode", usage: "notify-mode final-only|answer-updates|status", en: "Choose whether Slack channel notifications are final-only or include in-progress answer updates.", ko: "Slack 채널 알림을 최종 답변만 받을지, 진행 중 답변 업데이트까지 받을지 선택합니다." },
  { name: "steer", usage: "steer <prompt>", en: "Add input to an active in-flight turn.", ko: "실행 중인 turn에 추가 입력을 보냅니다." },
  { name: "resume", usage: "resume <number|codexThreadId|last> [prompt]", en: "Bind/resume a recent or existing Codex session.", ko: "번호 또는 ID로 기존 Codex 세션을 연결하거나 이어갑니다." },
  { name: "recent", usage: "recent [--channel name] [number]", en: "Show Slack and local Codex CLI sessions.", ko: "Slack 및 로컬 Codex CLI 최근 세션을 봅니다.", aliases: ["sessions"] },
  { name: "active", usage: "active [--channel name] [number]", en: "Show active CLI sessions or link one to a channel.", ko: "실행 중인 CLI 세션을 보거나 채널에 연결합니다." },
  { name: "history", usage: "history [session]", en: "Show commands sent in a session.", ko: "세션 내 이전 명령을 봅니다." },
  { name: "rerun", usage: "rerun [number|codexThreadId|last] [prompt]", en: "Open a preview picker, or rerun a stored prompt by send policy.", ko: "미리보기 선택 메뉴를 열거나 send policy에 따라 저장된 prompt를 다시 실행합니다." },
  { name: "rerun-session", usage: "rerun-session <number|codexThreadId|last> [prompt]", en: "Rerun a recent session by send policy.", ko: "send policy에 따라 최근 세션을 다시 실행합니다." },
  { name: "rerun-command", usage: "rerun-command [-f] <command-number> [session]", en: "Rerun a command from session history by send policy.", ko: "send policy에 따라 세션 이력의 명령을 다시 실행합니다." },
  { name: "pending", usage: "pending", en: "Show queued commands.", ko: "대기 중인 명령을 봅니다." },
  { name: "pending-edit", usage: "pending-edit <number|id> <prompt>", en: "Edit a queued command.", ko: "대기 중인 명령을 수정합니다." },
  { name: "pending-drop", usage: "pending-drop <number|id>", en: "Drop a queued command.", ko: "대기 중인 명령을 삭제합니다." },
  { name: "pending-run", usage: "pending-run <number|id|all>", en: "Run queued command(s).", ko: "대기 중인 명령을 실행합니다." },
  { name: "status", usage: "status", en: "Show the current session status.", ko: "현재 세션 상태를 봅니다." },
  { name: "stop", usage: "stop", en: "Interrupt the current active turn.", ko: "현재 실행 중인 turn을 중단합니다." }
];

export function commandSuggestions(query: string, limit = 8): CommandSuggestion[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return COMMAND_HELP.slice(0, limit).map((entry) => ({ entry, score: 100, reason: "prefix" }));
  }

  return COMMAND_HELP.map((entry) => scoreEntry(entry, normalized))
    .filter((suggestion): suggestion is CommandSuggestion => Boolean(suggestion))
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}

export function hasCommandSuggestion(query: string): boolean {
  return commandSuggestions(query, 1).length > 0;
}

export function renderCommandSuggestions(query: string, language: LanguageCode, prefix: string, suggestions = commandSuggestions(query)): string {
  const normalized = normalizeQuery(query);
  if (suggestions.length === 0) {
    return language === "ko"
      ? `일치하는 명령어가 없습니다: ${codeInline(query)}\n전체 목록: ${codeInline("commands")} / skill 목록: ${codeInline("$")}`
      : `No command matches ${codeInline(query)}.\nFull list: ${codeInline("commands")} / skills: ${codeInline("$")}`;
  }

  const title = language === "ko"
    ? normalized ? `명령어 추천: ${codeInline(query)}` : "사용 가능한 명령어:"
    : normalized ? `Command suggestions for ${codeInline(query)}:` : "Available commands:";
  const example = [prefix.trim(), suggestions[0].entry.usage].filter(Boolean).join(" ");
  const hint = language === "ko"
    ? `실행 예: ${codeInline(example)}`
    : `Example: ${codeInline(example)}`;

  return [
    title,
    ...suggestions.map(({ entry }) => `- ${codeInline(entry.usage)} - ${language === "ko" ? entry.ko : entry.en}`),
    "",
    hint
  ].join("\n");
}

function scoreEntry(entry: CommandHelpEntry, query: string): CommandSuggestion | undefined {
  const candidates = [entry.name, entry.usage.split(/\s+/)[0], ...(entry.aliases ?? [])]
    .map(normalizeQuery)
    .filter(Boolean);

  if (candidates.some((candidate) => candidate === query)) return { entry, score: 100, reason: "exact" };
  if (candidates.some((candidate) => candidate.startsWith(query))) return { entry, score: 90 - query.length / 100, reason: "prefix" };
  if (query.length >= 2 && candidates.some((candidate) => candidate.includes(query))) return { entry, score: 70 - query.length / 100, reason: "contains" };
  if (query.length >= 3) {
    const fuzzyCandidates = candidates.filter((candidate) => candidate[0] === query[0]);
    if (fuzzyCandidates.length === 0) return undefined;
    const bestDistance = Math.min(...fuzzyCandidates.map((candidate) => levenshtein(query, candidate)));
    if (bestDistance <= Math.max(1, Math.floor(query.length / 3))) {
      return { entry, score: 50 - bestDistance, reason: "fuzzy" };
    }
  }
  return undefined;
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function codeInline(text: string): string {
  return `\`${String(text).replaceAll("`", "ʼ")}\``;
}

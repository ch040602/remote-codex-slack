export type CommandName =
  | "help"
  | "commands"
  | "projects"
  | "skills"
  | "language"
  | "lang"
  | "언어"
  | "use"
  | "cd"
  | "ls"
  | "pwd"
  | "new"
  | "send"
  | "send-mode"
  | "send-policy"
  | "notify-mode"
  | "session"
  | "s"
  | "steer"
  | "resume"
  | "rerun"
  | "rerun-session"
  | "recent"
  | "sessions"
  | "active"
  | "history"
  | "rerun-command"
  | "pending"
  | "pending-edit"
  | "pending-drop"
  | "pending-run"
  | "status"
  | "stop"
  | "bind-session"
  | "unbind-session";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
  rawArgs: string;
  options: Record<string, string | boolean>;
  implicitSend?: boolean;
}

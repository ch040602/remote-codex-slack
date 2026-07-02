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
  | "steer"
  | "resume"
  | "rerun"
  | "rerun-session"
  | "recent"
  | "sessions"
  | "pending"
  | "pending-edit"
  | "pending-drop"
  | "pending-run"
  | "status"
  | "stop"
  | "bind-channel"
  | "unbind-channel";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
  rawArgs: string;
  options: Record<string, string | boolean>;
}

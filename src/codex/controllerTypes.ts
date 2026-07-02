import type { EventEmitter } from "node:events";
import type { SkillDef } from "../config.js";
import type { SlackThreadBinding, SessionStatus } from "../core/store.js";

export interface TurnCompletedEvent {
  slackKey: string;
  channelId: string;
  threadTs: string;
  codexThreadId: string;
  turnId?: string;
  status: SessionStatus;
  finalAnswer: string;
  errorMessage?: string;
}

export interface CodexTurnStartResult {
  turnId: string;
  referencedSkills: SkillDef[];
}

export interface CodexRuntime extends EventEmitter {
  start(): Promise<void>;
  createThread(params: {
    slackKey: string;
    channelId: string;
    threadTs: string;
    cwd: string;
    projectName?: string;
    createdBy: string;
    title?: string;
  }): Promise<SlackThreadBinding>;
  resumeThread(params: {
    slackKey: string;
    channelId: string;
    threadTs: string;
    codexThreadId: string;
    cwd: string;
    projectName?: string;
    createdBy: string;
  }): Promise<SlackThreadBinding>;
  startTurn(binding: SlackThreadBinding, prompt: string): Promise<CodexTurnStartResult>;
  sendOrSteer(binding: SlackThreadBinding, prompt: string): Promise<CodexTurnStartResult>;
  steer(binding: SlackThreadBinding, prompt: string): Promise<CodexTurnStartResult>;
  interrupt(binding: SlackThreadBinding): Promise<void>;
}


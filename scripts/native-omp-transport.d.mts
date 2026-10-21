import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface OmpDestination {
  host: string;
  user: string;
  botId: string;
  threadId: string;
  binary: string;
  stateRoot: string;
  profile?: string;
  cwd?: string;
  model?: string;
  expectedSessionId?: string;
  advisor?: boolean;
}
export interface OmpQuestion {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
}
export interface OmpSession { sessionId: string; sessionFile: string; resumed: boolean; cancelled: boolean }
export interface OmpReply { requestId: string; sessionId: string; sessionFile: string; text: string; sharedTurn?: boolean }
export function nativeOmpCommand(binding: OmpDestination): { command: string; args: string[]; sessionDir: string };
export class NativeOmpTransport extends EventEmitter {
  constructor(child: ChildProcessWithoutNullStreams, sessionDir: string, options?: { timeoutMs?: number; turnTimeoutMs?: number });
  static connect(binding: OmpDestination, options?: { timeoutMs?: number; turnTimeoutMs?: number }): NativeOmpTransport;
  initialize(): Promise<OmpSession>;
  submit(requestId: string, text: string): Promise<OmpReply>;
  answerUi(id: string, answer: { cancelled?: boolean; confirmed?: boolean; value?: string }): void;
  stop(): Promise<boolean>;
  close(): void;
}

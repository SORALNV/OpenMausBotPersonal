import { NativeOmpTransport, type OmpDestination } from './native-omp-transport.mjs';
/** Standard Collab guest; the native TUI retains sole ownership of the session writer. */
export class NativeOmpCollab extends NativeOmpTransport {
  constructor(binding: OmpDestination, options?: { timeoutMs?: number; answerTimeoutMs?: number; steerTimeoutMs?: number; stateCheckMs?: number; localUi?: typeof import("./native-omp-tui.mjs").nativeOmpTui; turnTimeoutMs?: number; reconnectTimeoutMs?: number; host?: NativeOmpCollab });
  static connect(binding: OmpDestination, options?: { timeoutMs?: number; answerTimeoutMs?: number; steerTimeoutMs?: number; stateCheckMs?: number; localUi?: typeof import("./native-omp-tui.mjs").nativeOmpTui; turnTimeoutMs?: number; reconnectTimeoutMs?: number; host?: NativeOmpCollab }): NativeOmpCollab;
  closed: boolean;
  tmux?: string;
  reconnect(): void;
  checkState(): Promise<void>;
  canSteer(): boolean;
  steer(id: string, text: string, images?: readonly {type:"image";data:string;mimeType:string}[]): Promise<'steered'|'indeterminate'|'refused'>;
  requestStatus(id: string): 'queued' | 'sent' | 'accepted' | 'completed' | undefined;
  recentFileWrites(): {path:string;content:string}[];
  pendingOperation(question: {title?:string;message?:string}): {id?:string;name:string;arguments:Record<string,unknown>} | undefined;
  reviewFiles(question: {title?:string;message?:string}, signal: AbortSignal): Promise<{path:string;content:string}[]>;
}
export function nativeToolPaths(args: unknown): string[];
export function sealOmpFrame(key: Buffer, frame: unknown): Buffer;
export function openOmpFrame(key: Buffer, data: Buffer): any;

export const READ_REVIEW_FILES: string;

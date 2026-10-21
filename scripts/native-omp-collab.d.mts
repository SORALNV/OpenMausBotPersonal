import { NativeOmpTransport, type OmpDestination } from './native-omp-transport.mjs';
/** Standard Collab guest; the native TUI retains sole ownership of the session writer. */
export class NativeOmpCollab extends NativeOmpTransport {
  constructor(binding: OmpDestination, options?: { timeoutMs?: number; turnTimeoutMs?: number });
  static connect(binding: OmpDestination, options?: { timeoutMs?: number; turnTimeoutMs?: number }): NativeOmpCollab;
  closed: boolean;
  tmux?: string;
  requestStatus(id: string): 'queued' | 'sent' | 'accepted' | 'completed' | undefined;
}
export function sealOmpFrame(key: Buffer, frame: unknown): Buffer;
export function openOmpFrame(key: Buffer, data: Buffer): any;

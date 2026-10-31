import { EventEmitter } from 'node:events';
import type { OmpDestination, OmpSession, OmpReply } from './native-omp-transport.mjs';
import type { nativeOmpCatalog } from './native-omp-catalog.mjs';
/** Standard DSH Web operator transport, with the shared native transport lifecycle. */
export class NativeDsh extends EventEmitter {
  static connect(binding: OmpDestination, options?: { timeoutMs?: number; turnTimeoutMs?: number }): NativeDsh;
  closed: boolean;
  initialize(): Promise<OmpSession>;
  submit(id: string, text: string, images?: readonly {type:"image";data:string;mimeType:string}[]): Promise<OmpReply>;
  command(type: string, args?: Record<string, unknown>): Promise<any>;
  answerUi(id: string, answer: { cancelled?: boolean; confirmed?: boolean; value?: string }): Promise<void>;
  stop(): Promise<boolean>;
  close(): void;
  canSteer(): boolean;
  steer(id: string, text: string, images?: readonly {type:"image";data:string;mimeType:string}[]): Promise<'steered'|'indeterminate'|'refused'>;
  requestStatus(id: string): 'queued'|'sent'|'accepted'|'completed'|undefined;
}
export const nativeDshCatalog: typeof nativeOmpCatalog;

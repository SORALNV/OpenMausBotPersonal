import type { OmpDestination } from './native-omp-transport.mjs';
import type { NativeOmpSessionInfo } from '../shared/native-omp.ts';
export function nativeOmpCatalog(binding: OmpDestination, action?: 'list'|'create'|'inspect', input?: { name?: string; operationId?: string }, options?: { signal?: AbortSignal }): Promise<{sessions?: NativeOmpSessionInfo[]; session?: NativeOmpSessionInfo; plan?: {remotePort?:number;tmux?:string}}>;
export class NativeOmpCatalog { run: typeof nativeOmpCatalog; }

import { NativeOmpCollab } from './native-omp-collab.mjs';
import type { OmpDestination } from './native-omp-transport.mjs';
export class NativeOmpPool {
  constructor(open?: (binding: OmpDestination, options: {timeoutMs?:number;host?:NativeOmpCollab})=>NativeOmpCollab);
  acquire(binding: OmpDestination): NativeOmpCollab;
  close(): void;
}

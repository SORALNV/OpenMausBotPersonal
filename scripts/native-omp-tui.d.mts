import type { OmpDestination } from './native-omp-transport.mjs';
export interface NativeLocalQuestion { id:string; fingerprint:string; operationId:string; method:'select'; title:string; options:string[]; rows:string[]; selected:number }
export function nativeOmpTui(binding:OmpDestination, metadata:any, action?:'probe'|'answer', answer?:{fingerprint?:string;operationId?:string;value?:string}, options?:{signal?:AbortSignal}):Promise<{question?:NativeLocalQuestion|null;approvalVisible?:boolean;received?:boolean}>;
export const OMP_TUI_PROGRAM:string;

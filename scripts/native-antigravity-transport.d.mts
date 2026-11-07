export type NativeProgress = { type: "text"; text: string } | { type: "tool"; id: string; name: string; state: "in_progress" | "completed" | "failed" };
export interface NativeSession { id: string; cwd: string; model: string; pending: boolean; nativeId?: string; lastStatus?: string }
export interface NativeReply { nativeId: string; text: string; model: string; permissionNotice: boolean }
export function antigravityCliModels(text: string): { id: string; name: string }[];
export class NativeAntigravityTransport {
  constructor(options: { command: string; args?: string[]; directory: string; env?: NodeJS.ProcessEnv; timeoutMs?: number });
  create(options: { cwd: string; model: string }): Promise<NativeSession>;
  read(id: string): Promise<NativeSession>;
  select(id: string, model: string): Promise<NativeSession>;
  models(): Promise<{ id: string; name: string }[]>;
  prompt(id: string, text: string, options?: { signal?: AbortSignal; progress?: (event: NativeProgress) => void }): Promise<NativeReply>;
}

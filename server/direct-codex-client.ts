import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { DirectThreadBinding, DirectTurnInput, DirectTurnReply } from "./direct-thread-bridge.ts";

export type NativeItem = { id: string; type: string; text?: string; phase?: string; clientId?: string; content?: { type: string; text?: string }[] };
export type NativeTurn = { id: string; status: string; items: NativeItem[]; error?: { message?: string } };
export type NativeAsk = { id: string; nativeRequestId?: string | number; method: string; params: Record<string, any>; answer(value: unknown): boolean | void };
export interface NativeClient {
  readonly shared?: boolean;
  request(method: string, params: unknown): Promise<any>;
  onEvent(listener: (method: string, params: any) => void): () => void;
  onAsk(listener: (ask: NativeAsk) => void): void;
  close(): Promise<void>;
}

/** This client opens a normal app-server process. It never edits native history or takes another runtime's writer lock. */
export class CodexNativeClient implements NativeClient {
  private child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(method: string, params: any) => void>();
  private ask?: (ask: NativeAsk) => void;
  private ended = false;
  private ownedThreads = new Set<string>();
  private closing?: Promise<void>;
  constructor(cli: string, nativeHome: string) {
    const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    this.child = spawn(cli, ["app-server", "--listen", "stdio://"], {
      env: { ...env, CODEX_HOME: nativeHome, CODEX_SQLITE_HOME: nativeHome }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    createInterface({ input: this.child.stdout }).on("line", line => {
      if (line.length > 8_000_000) return this.fail();
      let message: any;
      try { message = JSON.parse(line); } catch { return this.fail(); }
      if (message.method && message.id !== undefined) {
        if (!this.ask) return this.write({ id: message.id, error: { code: -32601, message: "No interactive client is attached" } });
        let answered = false;
        this.ask({ id: randomUUID(), nativeRequestId: message.id, method: message.method, params: message.params ?? {}, answer: value => {
          if (answered || this.ended) return;
          answered = true; this.write({ id: message.id, result: value });
        } });
      } else if (message.method) {
        for (const listener of this.listeners) listener(message.method, message.params);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(String(message.error.message ?? "Native request failed")));
        else pending.resolve(message.result);
      }
    });
  }
  private write(message: unknown): void { if (!this.ended) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  private fail(): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex native connection closed")); }
    this.pending.clear();
    for (const listener of this.listeners) listener("connection/closed", {});
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "openmausbot_direct", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized" });
  }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.ended) return Promise.reject(new Error("Codex native connection closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex native request timed out")); }, timeoutMs);
      this.pending.set(id, { resolve: (value: any) => {
        if (method === "thread/resume" && value.thread?.id) this.ownedThreads.add(value.thread.id);
        if (method === "thread/unsubscribe") this.ownedThreads.delete((params as { threadId: string }).threadId);
        resolve(value);
      }, reject, timer }); this.write({ id, method, params });
    });
  }
  onEvent(listener: (method: string, params: any) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onAsk(listener: (ask: NativeAsk) => void): void { this.ask = listener; }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    for (const threadId of this.ownedThreads) {
      try { await this.request("thread/unsubscribe", { threadId }, 1500); } catch {}
    }
    const exit = new Promise<void>(resolve => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await exit; clearTimeout(timer);
  }
}

/** Only thread ID and plain user input are submitted; no bot model, instructions, permissions or tool configuration are forwarded. */
export async function nativeTurn(client: NativeClient, binding: DirectThreadBinding, input: DirectTurnInput, signal: AbortSignal, started: (id: string) => void): Promise<DirectTurnReply> {
  signal.throwIfAborted();
  const resumed = await client.request("thread/resume", { threadId: binding.codexThreadId, excludeTurns: true });
  if (resumed.thread?.id !== binding.codexThreadId) throw new Error("Native thread identity mismatch");
  if (resumed.thread.status?.type === "active") throw new Error("M1MacControl is already working in its owning app");
  signal.throwIfAborted();
  let turnId: string | undefined;
  const completed = new Map<string, NativeTurn>();
  const items = new Map<string, Map<string, NativeItem>>();
  let finish!: (turn: NativeTurn) => void, fail!: (error: Error) => void;
  const terminal = new Promise<NativeTurn>((resolve, reject) => { finish = resolve; fail = reject; });
  void terminal.catch(() => {});
  const remove = client.onEvent((method, params) => {
    if (method === "connection/closed") return fail(new Error("Native connection closed; the input may have been accepted. Do not resend automatically."));
    if (params?.threadId !== binding.codexThreadId) return;
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      let turnItems = items.get(params.turnId);
      if (!turnItems) { turnItems = new Map(); items.set(params.turnId, turnItems); }
      turnItems.set(params.item.id, params.item); return;
    }
    if (method !== "turn/completed") return;
    completed.set(params.turn.id, params.turn);
    if (params.turn.id === turnId) finish(params.turn);
  });
  const stop = () => {
    if (turnId) void client.request("turn/interrupt", { threadId: binding.codexThreadId, turnId }).catch(() => {});
    fail(new Error("Native turn stopped; no automatic retry"));
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const reply = await client.request("turn/start", { threadId: binding.codexThreadId, clientUserMessageId: input.requestId,
      input: [{ type: "text", text: input.text, text_elements: [] }] });
    turnId = reply.turn?.id;
    if (!turnId) throw new Error("Native turn acknowledgement missing; do not resend automatically");
    started(turnId);
    if (signal.aborted) stop();
    if (completed.has(turnId)) finish(completed.get(turnId)!);
    const turn = await terminal;
    if (turn.status !== "completed") throw new Error(turn.error?.message ?? `Native turn ${turn.status}`);
    const answers = [...(turn.items ?? []), ...items.get(turn.id)?.values() ?? []].filter(item => item.type === "agentMessage");
    const text = (answers.filter(item => item.phase === "final_answer").at(-1) ?? answers.at(-1))?.text;
    if (typeof text !== "string" || !text.trim()) throw new Error("Native turn returned no final text");
    return { codexThreadId: binding.codexThreadId, turnId, text };
  } finally { remove(); signal.removeEventListener("abort", stop); }
}

export async function nativeHistory(client: NativeClient, threadId: string, limit = 20): Promise<NativeTurn[]> {
  const meta = await client.request("thread/read", { threadId });
  if (meta.thread?.id !== threadId) throw new Error("Native history identity mismatch");
  const page = await client.request("thread/turns/list", { threadId, limit, itemsView: "full", sortDirection: "desc" });
  return (page.data ?? page.turns ?? []).slice().reverse();
}

import { createConnection } from "node:net";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { NativeAsk, NativeClient } from "./direct-codex-client.ts";

/** Connects only to an owner-private Unix socket; closing a client never stops the shared runtime. */
export class CodexSharedClient implements NativeClient {
  readonly shared = true;
  private ws: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(method: string, params: any) => void>();
  private asks = new Map<string | number, { answered: boolean; threadId?: string; turnId?: string; itemId?: string }>();
  private ask?: (ask: NativeAsk) => void;
  private subscriptions = new Set<string>();
  private ended = false;
  private closing?: Promise<void>;
  private connected: Promise<void>;
  constructor(socketPath: string) {
    const dir = dirname(socketPath), owner = process.getuid?.();
    if (!isAbsolute(socketPath) || realpathSync(dir) !== dir) throw new Error("A private absolute native socket is required");
    const parent = lstatSync(dir), entry = lstatSync(socketPath), targetPath = realpathSync(socketPath);
    const targetParent = lstatSync(dirname(targetPath)), socket = lstatSync(targetPath);
    if (!parent.isDirectory() || parent.uid !== owner || parent.mode & 0o077 || entry.uid !== owner || !targetParent.isDirectory() || targetParent.uid !== owner || targetParent.mode & 0o077 || !socket.isSocket() || socket.uid !== owner || socket.mode & 0o077) throw new Error("Shared native socket must be owner-private");
    this.ws = new WebSocket("ws://localhost/rpc", { createConnection: () => createConnection(targetPath), handshakeTimeout: 5000, maxPayload: 8_000_000, perMessageDeflate: false });
    this.connected = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", () => reject(new Error("Shared native connection failed")));
      this.ws.once("close", () => reject(new Error("Shared native connection closed")));
    });
    void this.connected.catch(() => {});
    this.ws.on("error", () => this.fail());
    this.ws.on("close", () => this.fail());
    this.ws.on("message", data => {
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { this.ws.terminate(); return this.fail(); }
      if (!message || typeof message !== "object") { this.ws.terminate(); return this.fail(); }
      if (message.method && message.id !== undefined) {
        if (this.asks.size >= 128) { this.ws.terminate(); return this.fail(); }
        const state = { answered: false, threadId: message.params?.threadId, turnId: message.params?.turnId, itemId: message.params?.callId ?? message.params?.itemId }; this.asks.set(message.id, state);
        this.ask?.({ id: randomUUID(), nativeRequestId: message.id, method: message.method, params: message.params ?? {}, answer: value => {
          if (state.answered || this.ended) return false;
          state.answered = true; this.asks.delete(message.id); this.write({ id: message.id, result: value });
          return true;
        } });
      } else if (message.method) {
        if (message.method === "serverRequest/resolved") {
          const state = this.asks.get(message.params?.requestId);
          if (state) state.answered = true;
          this.asks.delete(message.params?.requestId);
        }
        if (message.method === "turn/completed" || message.method === "item/completed") {
          for (const [id, state] of this.asks) {
            if (state.threadId === message.params?.threadId && (message.method === "turn/completed" ? state.turnId === message.params?.turn.id : state.itemId === message.params?.item.id)) {
              state.answered = true; this.asks.delete(id);
            }
          }
        }
        for (const listener of this.listeners) listener(message.method, message.params);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(String(message.error.message ?? "Shared native request failed")));
        else pending.resolve(message.result);
      }
    });
  }
  private write(message: unknown): void { if (!this.ended && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  private fail(): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Shared native connection closed")); }
    this.pending.clear(); this.asks.clear();
    for (const listener of this.listeners) listener("connection/closed", {});
  }
  async initialize(): Promise<void> {
    await this.connected;
    await this.request("initialize", { clientInfo: { name: "openmausbot_shared", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized" });
  }
  request(method: string, params: any, timeoutMs = 30_000): Promise<any> {
    if (this.ended || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Shared native connection is unavailable"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Shared native request timed out; do not resend automatically")); }, timeoutMs);
      this.pending.set(id, { timer, reject, resolve: value => {
        if (["thread/resume", "thread/start", "thread/fork"].includes(method) && value.thread?.id) this.subscriptions.add(value.thread.id);
        if (method === "thread/unsubscribe") this.subscriptions.delete(params.threadId);
        resolve(value);
      } });
      this.write({ id, method, params });
    });
  }
  onEvent(listener: (method: string, params: any) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onAsk(listener: (ask: NativeAsk) => void): void { this.ask = listener; }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    if (this.ended) return;
    for (const threadId of this.subscriptions) { try { await this.request("thread/unsubscribe", { threadId }, 1500); } catch {} }
    this.ws.terminate(); this.fail();
  }
}

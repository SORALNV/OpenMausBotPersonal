import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DirectCodexSettings, DirectThreadBinding } from "../shared/direct-codex.ts";
import { DirectThreadBridge, presentDirectReply, type ReplyFormatter } from "./direct-thread-bridge.ts";
import { nativeHistory, nativeTurn, type NativeAsk, type NativeClient } from "./direct-codex-client.ts";
import type { Message, Store } from "./store.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";
import type { RequestOutcome } from "./contracts.ts";
import { relayThroughMediator, type RelayTextGenerator } from "./codex-relay-mediator.ts";

type Binding = DirectCodexSettings["bindings"][number];
type Active = { client: NativeClient; controller: AbortController; source: Message; cards: Map<string, { ask: NativeAsk; card: Message }>; turnId?: string; onSettled?: () => void };
type Pending = { ask: NativeAsk; card: Message; binding: Binding };
type Watcher = { client: NativeClient; binding: Binding; turnId?: string };
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/.test(value);
const error = (message: string) => Object.assign(new Error(message), { status: 409 });

export class DirectCodexService {
  private dir: string;
  private store: Store;
  private open: () => Promise<NativeClient>;
  private formatter: ReplyFormatter;
  private settled: () => void;
  private readonly file: string;
  private settings: DirectCodexSettings = { bindings: [] };
  private active = new Map<string, Active>();
  private syncing = new Set<string>();
  private states = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private changing = false;
  private generate?: RelayTextGenerator;
  private pending = new Map<string, Pending>();
  private watchers = new Map<string, Watcher>();
  private connecting = new Set<string>();
  private closed = false;
  constructor(dir: string, store: Store, open: () => Promise<NativeClient>, formatter: ReplyFormatter, settled: () => void, generate?: RelayTextGenerator) {
    this.dir = dir; this.store = store; this.open = open; this.formatter = formatter; this.settled = settled;
    this.file = join(dir, "direct-codex.json");
    this.generate = generate;
    if (existsSync(this.file)) {
      const info = lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077 || info.size > 100_000) throw error("Invalid private native binding settings");
      this.settings = this.validate(JSON.parse(readFileSync(this.file, "utf8")));
    }
  }
  private validate(value: any): DirectCodexSettings {
    if (!Array.isArray(value?.bindings) || value.bindings.length > 50) throw error("Invalid bindings");
    const seen = new Set<string>();
    return { bindings: value.bindings.map((b: any): Binding => {
      if (!validId(b.botId) || !validId(b.threadId) || !validId(b.codexThreadId) || b.hostId !== "local" || typeof b.enabled !== "boolean" || seen.has(b.threadId)) throw error("One explicit local Codex thread is required per bot thread");
      seen.add(b.threadId);
      for (const selection of [b.formatter, b.mediator]) {
        if (selection && (typeof selection.providerId !== "string" || !/^[\w-]{1,100}$/.test(selection.providerId) || typeof selection.modelId !== "string" || !/^[\w./:-]{1,160}$/.test(selection.modelId) || !Number.isInteger(selection.timeoutMs) || selection.timeoutMs < 1000 || selection.timeoutMs > 60000)) throw error("Invalid relay model selection");
      }
      if (b.mediator && !this.generate) throw error("Input mediation is unavailable in this server");
      return { botId: b.botId, threadId: b.threadId, codexThreadId: b.codexThreadId, hostId: "local", enabled: b.enabled,
        ...(b.formatter ? { formatter: { providerId: b.formatter.providerId, modelId: b.formatter.modelId, timeoutMs: b.formatter.timeoutMs } } : {}),
        ...(b.mediator ? { mediator: { providerId: b.mediator.providerId, modelId: b.mediator.modelId, timeoutMs: b.mediator.timeoutMs } } : {}),
        ...(validId(b.lastNativeTurnId) ? { lastNativeTurnId: b.lastNativeTurnId } : {}) };
    }) };
  }
  private save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink()) throw error("Native settings directory must not be a symlink");
    chmodSync(this.dir, 0o700);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.settings), { mode: 0o600, flag: "wx" }); renameSync(temp, this.file);
  }
  binding(botId: string, threadId: string): Binding | undefined { return this.settings.bindings.find(b => b.enabled && b.botId === botId && b.threadId === threadId); }
  private syncState(threadId: string, state: string): void {
    const current = this.states.get(threadId);
    if (!current || ["idle", "sync-error", "history-gap"].includes(current)) this.states.set(threadId, state);
  }
  private checkpoint(binding: Binding, turnId: string): void {
    if (!this.settings.bindings.includes(binding)) return;
    binding.lastNativeTurnId = turnId; this.save();
  }
  startPolling(): void {
    if (this.closed || this.timer) return;
    const tick = () => { for (const binding of this.settings.bindings.filter(b => b.enabled)) void this.ensureWatcher(binding).then(() => this.sync(binding)).catch(() => {}); };
    tick(); this.timer = setInterval(tick, 15000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...this.active.keys()].map(thread => this.stop(thread)));
    await this.closeWatchers();
  }
  async stop(threadId: string): Promise<boolean> {
    const active = this.active.get(threadId);
    if (!active) return false;
    active.controller.abort();
    await active.client?.close(); return true;
  }
  answer(threadId: string, requestId: string, behavior: string, message?: string): RequestOutcome | undefined {
    const pending = this.pending.get(requestId);
    if (!pending || pending.binding.threadId !== threadId) return undefined;
    const { ask, card } = pending;
    let response: unknown, outcome: RequestOutcome;
    if (ask.method === "item/tool/requestUserInput") {
      if (behavior !== "answer" || !message?.trim()) return "unavailable";
      const questions = ask.params.questions ?? [];
      if (questions.length !== 1) return "unavailable";
      response = { answers: { [questions[0].id]: { answers: [message] } } }; outcome = "answered";
    } else {
      if (!["allow", "deny"].includes(behavior)) return "unavailable";
      response = { decision: behavior === "allow" ? "accept" : "decline" }; outcome = behavior === "allow" ? "allowed-once" : "rejected";
    }
    if (ask.answer(response) === false) { this.expirePending(requestId); return "unavailable"; }
    this.pending.delete(requestId); this.active.get(threadId)?.cards.delete(requestId);
    this.store.patchMessage(threadId, card.id, { card: { ...card.card!, answered: behavior, ...(message ? { answeredText: message } : {}) } });
    this.store.setTaskActivity(this.store.botByThread(threadId)!.id, threadId, "working");
    return outcome;
  }
  private expirePending(requestId: string): void {
    const pending = this.pending.get(requestId); if (!pending) return;
    this.pending.delete(requestId); this.active.get(pending.binding.threadId)?.cards.delete(requestId);
    this.store.patchMessage(pending.binding.threadId, pending.card.id, { card: { ...pending.card.card!, expired: true } });
  }
  private resolved(threadId: string, nativeRequestId: string | number): void {
    for (const [id, pending] of this.pending) if (pending.binding.threadId === threadId && pending.ask.nativeRequestId === nativeRequestId) this.expirePending(id);
  }
  private ask(binding: Binding, active: Active | undefined, ask: NativeAsk, shared = false): void {
    if (ask.params.threadId !== binding.codexThreadId || !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].includes(ask.method)) {
      if (!shared && active) { active.controller.abort(); void active.client.close(); } return;
    }
    const question = ask.method === "item/tool/requestUserInput";
    if (question && ask.params.questions?.length !== 1) { if (!shared && active) { active.controller.abort(); void active.client.close(); } return; }
    if (ask.nativeRequestId !== undefined && [...this.pending.values()].some(p => p.binding.threadId === binding.threadId && p.ask.nativeRequestId === ask.nativeRequestId)) return;
    const card = this.store.appendMessage(binding.threadId, { role: "bot", kind: "options", card: {
      title: question ? "Codexからの確認" : "Codexの操作許可", subtitle: question ? String(ask.params.questions[0].question) : String(ask.params.command ?? ask.params.reason ?? "ファイル変更の許可を確認してください。"),
      options: question ? (ask.params.questions[0].options ?? []).map((option: any) => String(option.label)) : ["Allow", "Deny"],
      requestId: ask.id, requestType: question ? "question" : "permission", tool: ask.method,
    } });
    this.pending.set(ask.id, { ask, card, binding });
    active?.cards.set(ask.id, { ask, card }); this.store.setTaskActivity(binding.botId, binding.threadId, "waiting-on-you");
  }
  private async closeWatchers(): Promise<void> {
    const watchers = [...this.watchers.values()]; this.watchers.clear();
    await Promise.all(watchers.map(w => w.client.close()));
    for (const id of this.pending.keys()) this.expirePending(id);
  }
  private async ensureWatcher(binding: Binding): Promise<void> {
    if (this.closed || this.changing || this.watchers.has(binding.threadId) || this.connecting.has(binding.threadId)) return;
    this.connecting.add(binding.threadId); let client: NativeClient | undefined;
    try {
      client = await this.open();
      if (this.closed || !client.shared || !this.settings.bindings.includes(binding) || !binding.enabled) { await client.close(); return; }
      const watcher: Watcher = { client, binding };
      this.watchers.set(binding.threadId, watcher);
      client.onAsk(ask => { if (this.watchers.get(binding.threadId) === watcher) this.ask(binding, this.active.get(binding.threadId), ask, true); });
      client.onEvent((method, params) => {
        if (this.watchers.get(binding.threadId) !== watcher) return;
        if (method === "connection/closed") {
          this.watchers.delete(binding.threadId); this.states.set(binding.threadId, "disconnected");
          for (const [id, pending] of this.pending) if (pending.binding.threadId === binding.threadId) this.expirePending(id);
          if (!this.active.has(binding.threadId)) this.store.setTaskActivity(binding.botId, binding.threadId, "idle");
          return;
        }
        if (params?.threadId !== binding.codexThreadId) return;
        if (method === "serverRequest/resolved") this.resolved(binding.threadId, params.requestId);
        if (method === "turn/started") { watcher.turnId = params.turn.id; this.states.set(binding.threadId, "working"); this.store.setTaskActivity(binding.botId, binding.threadId, "working"); }
        if (method === "item/completed" && params.item?.type === "userMessage") {
          const item = params.item, existing = this.store.messagesFor(binding.threadId);
          const known = existing.some(message => item.clientId && message.id === item.clientId || message.nativeCodex?.turnId === params.turnId && message.nativeCodex?.itemId === item.id);
          const text = item.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
          if (!known && text) this.store.appendMessage(binding.threadId, { role: "user", kind: "text", text, nativeCodex: { threadId: binding.codexThreadId, turnId: params.turnId, itemId: item.id } });
        }
        if (method === "turn/completed" && (!watcher.turnId || watcher.turnId === params.turn.id)) {
          watcher.turnId = undefined;
          for (const [id, pending] of this.pending) if (pending.binding.threadId === binding.threadId && pending.ask.params.turnId === params.turn.id) this.expirePending(id);
          if (!this.active.has(binding.threadId)) {
            this.states.set(binding.threadId, params.turn.status === "completed" ? "idle" : "native-" + params.turn.status);
            this.store.setTaskActivity(binding.botId, binding.threadId, "idle");
            void this.sync(binding).finally(() => this.settled());
          }
        }
      });
      const resumed = await client.request("thread/resume", { threadId: binding.codexThreadId, excludeTurns: true });
      if (resumed.thread?.id !== binding.codexThreadId) throw error("Shared native identity mismatch");
      if (resumed.thread.status?.type === "active") { this.states.set(binding.threadId, "working"); this.store.setTaskActivity(binding.botId, binding.threadId, "working"); }
      else this.syncState(binding.threadId, "idle");
    } catch (cause) {
      if (this.watchers.get(binding.threadId)?.client === client) this.watchers.delete(binding.threadId);
      await client?.close(); this.syncState(binding.threadId, "sync-error"); throw cause;
    } finally { this.connecting.delete(binding.threadId); }
  }
  dispatch(binding: Binding, text: string, fields: Pick<Message, "sendId" | "sender" | "via" | "callId"> = {}, existingSource?: Message, onSettled?: () => void): Message {
    if (this.changing || this.syncing.has(binding.threadId) || this.active.has(binding.threadId) || this.store.taskByThread(binding.botId, binding.threadId)?.busy) throw error("Native thread is already working");
    if (!text.trim() || text.length > 100_000 || /<attached-(?:image|file|audio)\b|\[.*?\]\((?:attachment:|\/?api\/attachments\/)|data:(?:image|audio)\//i.test(text)) throw error("Direct Codex accepts plain text only");
    const source = existingSource ?? this.store.appendMessage(binding.threadId, { role: "user", kind: "text", text, ...fields, requestPending: true });
    if (existingSource) this.store.patchMessage(binding.threadId, source.id, { requestPending: true });
    this.store.setTaskActivity(binding.botId, binding.threadId, "working");
    this.states.set(binding.threadId, "working");
    const controller = new AbortController();
    const job = { controller, source, cards: new Map(), client: undefined as unknown as NativeClient, onSettled };
    this.active.set(binding.threadId, job);
    void this.run(binding, text, job);
    return source;
  }
  private async run(binding: Binding, text: string, active: Active): Promise<void> {
    const timer = setTimeout(() => active.controller.abort(), 30 * 60_000); timer.unref();
    let submitted = false;
    try {
      active.client = await this.open(); active.controller.signal.throwIfAborted();
      active.client.onAsk(ask => this.ask(binding, active, ask, active.client.shared));
      const resolved = active.client.onEvent((method, params) => { if (method === "serverRequest/resolved" && params?.threadId === binding.codexThreadId) this.resolved(binding.threadId, params.requestId); });
      const submit = (_b: Readonly<DirectThreadBinding>, input: { requestId: string; text: string }) => {
        submitted = true;
        return nativeTurn(active.client, binding, input, active.controller.signal, id => { active.turnId = id; });
      };
      const bridge = new DirectThreadBridge([binding], { submit: (_b, input) => binding.mediator
        ? relayThroughMediator(binding, input, binding.mediator, this.generate!, submit, active.controller.signal)
        : submit(binding, input) }, this.formatter);
      const result = await bridge.send(binding.botId, binding.threadId, { requestId: active.source.id, text }, binding.formatter);
      resolved();
      const reply = this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: result.rawText, turnId: result.turnId,
        requestMessageId: active.source.id, turnSucceeded: true, turnTerminal: true, turnCompletedAt: Date.now(),
        nativeCodex: { threadId: binding.codexThreadId, turnId: result.turnId, originalText: result.rawText } });
      this.checkpoint(binding, result.turnId);
      void result.presentation.then(presentation => {
        if (!this.store.taskByThread(binding.botId, binding.threadId)) return;
        this.store.patchMessage(binding.threadId, reply.id, { text: presentation.text, nativeCodex: { ...reply.nativeCodex!, formatted: presentation.formatted, formatterFailure: presentation.failure } });
      }).catch(() => {});
      this.states.set(binding.threadId, "idle");
    } catch (cause) {
      const conflict = cause instanceof Error && /active writer|already working/.test(cause.message);
      const preparationFailed = Boolean(binding.mediator) && !submitted && !active.controller.signal.aborted;
      this.states.set(binding.threadId, conflict ? "writer-conflict" : active.controller.signal.aborted ? "stopped" : preparationFailed ? "preparation-error" : "error");
      const message = conflict
        ? "Codexアプリがこの会話を使用中です。会話の読み込みを解除してから送信してください。自動再送はしていません。"
        : active.controller.signal.aborted ? "Codexへの接続を停止しました。自動再送はしていません。"
        : preparationFailed ? "仲介モデルが依頼を準備できなかったため、接続先Codexへは送信していません。仲介モデルの設定を確認してください。"
          : "Codexとの接続に失敗しました。入力が受理された可能性があるため、元の会話を確認してください。自動再送はしていません。";
      this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: message,
        requestMessageId: active.source.id, turnId: active.turnId ?? `native-error-${active.source.id}`,
        turnSucceeded: false, turnTerminal: true, turnCompletedAt: Date.now() });
    } finally {
      clearTimeout(timer);
      await active.client?.close();
      for (const id of active.cards.keys()) this.expirePending(id);
      this.store.patchMessage(binding.threadId, active.source.id, { requestPending: false, ...(active.controller.signal.aborted ? { requestCancelled: true } : {}) });
      if (this.active.get(binding.threadId) === active) {
        this.active.delete(binding.threadId); this.store.setTaskActivity(binding.botId, binding.threadId, "idle"); active.onSettled?.(); this.settled();
      }
    }
  }
  async sync(binding: Binding): Promise<void> {
    if (this.closed || this.changing || this.active.has(binding.threadId) || this.syncing.has(binding.threadId) || !this.store.taskByThread(binding.botId, binding.threadId)) return;
    this.syncing.add(binding.threadId);
    let client: NativeClient | undefined;
    try {
      client = await this.open();
      const turns = await nativeHistory(client, binding.codexThreadId, 50);
      if (!binding.lastNativeTurnId) { const last = turns.filter(t => t.status === "completed").at(-1); if (last) this.checkpoint(binding, last.id); return; }
      const anchor = turns.findIndex(turn => turn.id === binding.lastNativeTurnId);
      if (anchor < 0) { this.syncState(binding.threadId, "history-gap"); return; }
      for (const turn of turns.slice(anchor + 1)) {
        if (!["completed", "failed", "interrupted"].includes(turn.status)) break;
        const existing = this.store.messagesFor(binding.threadId);
        const finalAnswers = turn.items.filter(item => item.type === "agentMessage" && (!item.phase || item.phase === "final_answer") && item.text?.trim());
        const succeeded = turn.status === "completed" && finalAnswers.length > 0;
        for (const item of turn.items.filter(item => item.type === "userMessage" || succeeded && finalAnswers.includes(item))) {
          if (existing.some(message => message.nativeCodex?.turnId === turn.id && message.nativeCodex.itemId === item.id || item.clientId && message.id === item.clientId)) continue;
          const text = item.type === "userMessage" ? item.content?.filter(c => c.type === "text").map(c => c.text).join("\n") : item.text;
          if (!text) continue;
          const message = this.store.appendMessage(binding.threadId, { role: item.type === "userMessage" ? "user" : "bot", kind: "text", text,
            nativeCodex: { threadId: binding.codexThreadId, turnId: turn.id, itemId: item.id, ...(item.type === "agentMessage" ? { originalText: text } : {}) } });
          if (item.type === "agentMessage" && binding.formatter) {
            const question = turn.items.filter(i => i.type === "userMessage").flatMap(i => i.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
            void presentDirectReply(question, text, this.formatter, binding.formatter).then(presentation => {
              if (this.store.taskByThread(binding.botId, binding.threadId)) this.store.patchMessage(binding.threadId, message.id, { text: presentation.text, nativeCodex: { ...message.nativeCodex!, formatted: presentation.formatted, formatterFailure: presentation.failure } });
            }).catch(() => {});
          }
        }
        if (!succeeded && !this.store.messagesFor(binding.threadId).some(message => message.turnId === turn.id && message.turnSucceeded === false)) {
          this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: turn.status === "completed"
            ? "Codexの最終回答が空でした。操作が実行済みの可能性があるため、ChatGPTアプリで結果を確認してください。同じ操作は自動再送していません。"
            : "Codexの処理は失敗または中断しました。ChatGPTアプリで結果を確認してください。同じ操作は自動再送していません。",
            turnId: turn.id, turnSucceeded: false, turnTerminal: true, turnCompletedAt: Date.now(), nativeCodex: { threadId: binding.codexThreadId, turnId: turn.id, itemId: "native-terminal-error" } });
        }
        this.states.set(binding.threadId, succeeded ? "idle" : turn.status === "completed" ? "empty-answer" : "native-" + turn.status);
        this.checkpoint(binding, turn.id);
      }
      this.syncState(binding.threadId, "idle");
    } catch { this.syncState(binding.threadId, "sync-error"); }
    finally { await client?.close(); this.syncing.delete(binding.threadId); }
  }
  route: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    if (!["/api/direct-codex", "/api/direct-codex/threads"].includes(path) || !["GET", "PUT", "POST"].includes(method)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "所有者だけが接続先を設定できます。" });
    try {
      if (path.endsWith("/threads")) {
        if (method !== "GET") return json(res, 405, { error: "GET required" });
        const client = await this.open();
        try {
          const result = await client.request("thread/list", { limit: 100, sourceKinds: [] });
          return json(res, 200, { threads: (result.data ?? []).map((thread: any) => ({ id: thread.id, name: thread.name ?? thread.preview ?? thread.id })) });
        } finally { await client.close(); }
      }
      if (method === "PUT") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
        const next = this.validate(await readBody(req, 100_000));
        if (this.changing || this.active.size || this.syncing.size || next.bindings.some(b => this.store.taskByThread(b.botId, b.threadId)?.busy)) throw error("Stop active work before changing bindings");
        this.changing = true;
        try {
        for (const binding of next.bindings) {
          if (binding.enabled && !this.store.taskByThread(binding.botId, binding.threadId)) throw error("Source bot thread does not exist");
          const previous = this.settings.bindings.find(b => b.threadId === binding.threadId);
          if (previous && previous.codexThreadId !== binding.codexThreadId) throw error("Create a new bot thread to bind a different native session");
          binding.lastNativeTurnId = previous?.lastNativeTurnId;
          if (binding.enabled && !previous?.enabled) {
            const client = await this.open();
            try { const turns = await nativeHistory(client, binding.codexThreadId, 1); binding.lastNativeTurnId = turns.at(-1)?.id; }
            finally { await client.close(); }
          }
        }
        await this.closeWatchers(); this.settings = next; this.save();
        } finally { this.changing = false; }
        if (this.timer) await Promise.all(this.settings.bindings.filter(b => b.enabled).map(b => this.ensureWatcher(b).catch(() => {})));
      }
      if (method === "POST") await Promise.all(this.settings.bindings.filter(b => b.enabled).map(b => this.sync(b)));
      return json(res, 200, { settings: this.settings, states: Object.fromEntries(this.states), sharedConnectedThreads: [...this.watchers.keys()] });
    } catch (cause) { return json(res, 409, { error: cause instanceof Error ? cause.message : "Native settings failed" }); }
  };
}

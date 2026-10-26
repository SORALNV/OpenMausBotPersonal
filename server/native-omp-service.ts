import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { NativeOmpTransport, nativeOmpCommand, type OmpQuestion, type OmpDestination } from "../scripts/native-omp-transport.mjs";
import { NativeOmpCollab } from "../scripts/native-omp-collab.mjs";
import { NativeOmpPool } from "../scripts/native-omp-pool.mjs";
import type { NativeOmpBinding, NativeOmpThreadTarget } from "../shared/native-omp.ts";
import { NativeOmpSessions } from "./native-omp-sessions.ts";
import type { RequestOutcome } from "./contracts.ts";
import type { RelayTextGenerator } from "./codex-relay-mediator.ts";
import { presentDirectReply, type ReplyFormatter } from "./direct-thread-bridge.ts";
import type { Message, Store } from "./store.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { classifyNativeRisk, type NativeRiskDecision } from "./native-omp-review.ts";
import { automaticReportDecline, japaneseNativeQuestion, japanesePermissionDetail, nativeToolApproval } from "./native-omp-question.ts";
import { nativeAuditText, nativeConsentCommand } from "./native-omp-consent.ts";
import { questionAnswersByQuestion } from "../shared/ask-question.ts";

type Binding = NativeOmpBinding & OmpDestination;
type Receipt = { digest: string; stage: "prepared" | "submitted" | "completed" | "not-sent" | "indeterminate"; sessionId?: string; admissionEntryId?: string; failure?: { phase: string; status?: string } };
type Active = { controller: AbortController; source: Pick<Message, "id" | "text">; client?: NativeOmpTransport; questions: Set<string>; cards: Map<string, { nativeId: string; question: OmpQuestion; card: Message; allowValue?: string; choices?: Map<string, string> }>; stopped: boolean; onSettled?: () => void };
type NativeProgress = { requestId: string; turnId: string; rowId?: string; completed: string[] };
type NativeToolProgress = { type: string; toolName?: string; isError?: boolean; args?: unknown; toolCallId?: string };
type NativeAudit = { row: Message; name: string; callId?: string; command?: string; started: boolean };
const refuse = (message: string) => Object.assign(new Error(message), { status: 409 });
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/u.test(value);

export class NativeOmpService {
  private settings: { bindings: NativeOmpBinding[] } = { bindings: [] };
  private ledger: Record<string, Receipt> = {};
  private sessions: Record<string, string> = {};
  private observed: Record<string, string[]> = {};
  private clients = new Map<string, NativeOmpTransport>();
  private active = new Map<string, Active>();
  private sharedQuestions = new Map<string, Active>();
  private nativeBusy = new Map<string, boolean>();
  private states = new Map<string, string>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private closing = false;
  private progress = new Map<string, NativeProgress>();
  private consent = new Map<string, { requestId?: string; expiresAt: number }>();
  private audits = new Map<string, NativeAudit[]>();
  private configuring = new Set<string>();
  private readonly pool = new NativeOmpPool();
  private readonly management: NativeOmpSessions;
  private readonly sharedOpen: (binding: OmpDestination) => NativeOmpTransport;
  private readonly file: string;
  private readonly ledgerFile: string;
  private readonly sessionsFile: string;
  private readonly observedFile: string;
  private readonly dir: string;
  private readonly store: Store;
  private readonly open: (binding: OmpDestination) => NativeOmpTransport;
  private readonly generate: RelayTextGenerator;
  private readonly formatter: ReplyFormatter;
  private readonly settled: () => void;

  constructor(input: { dir: string; store: Store; open?: (binding: OmpDestination) => NativeOmpTransport; sharedOpen?: (binding: OmpDestination) => NativeOmpTransport; catalog?: ConstructorParameters<typeof NativeOmpSessions>[0]["catalog"]; generate: RelayTextGenerator; formatter: ReplyFormatter; settled: () => void }) {
    this.dir = input.dir; this.store = input.store; this.open = input.open ?? (binding => NativeOmpTransport.connect(binding, { timeoutMs: 90_000 }));
    this.generate = input.generate; this.formatter = input.formatter; this.settled = input.settled;
    this.sharedOpen = input.sharedOpen ?? (binding => this.pool.acquire(binding));
    this.file = join(input.dir, "native-omp.json");
    this.ledgerFile = join(input.dir, "native-omp-ledger.json");
    this.sessionsFile = join(input.dir, "native-omp-sessions.json");
    this.observedFile = join(input.dir, "native-omp-observed.json");
    if (existsSync(this.file)) this.settings = this.validate(this.read(this.file));
    if (existsSync(this.ledgerFile)) {
      const value = this.read(this.ledgerFile);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value as Record<string, Receipt>).some(([key, item]) => !validId(key) || !item || typeof item !== "object" || !/^[a-f0-9]{64}$/u.test(item.digest ?? "") || !["prepared", "submitted", "completed", "not-sent", "indeterminate"].includes(item.stage))) throw refuse("Invalid native request ledger");
      this.ledger = value;
    }
    if (existsSync(this.sessionsFile)) {
      const value = this.read(this.sessionsFile);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([key, id]) => !validId(key) || !validId(id))) throw refuse("Invalid native session mapping");
      this.sessions = value;
    }
    if (existsSync(this.observedFile)) {
      const value = this.read(this.observedFile);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([key, ids]) => !validId(key) || !Array.isArray(ids) || ids.length > 10000 || ids.some(id => !validId(id)))) throw refuse("Invalid native history cursor");
      this.observed = value;
    }
    for (const threadId of Object.keys(this.sessions)) if (this.observed[threadId]) {
      const key = this.historyKey(threadId, this.sessions[threadId]!);
      this.observed[key] ??= this.observed[threadId]!; delete this.observed[threadId];
    }
    this.management = new NativeOmpSessions({ dir: input.dir, store: input.store, read: file => this.read(file), save: (file, data) => this.save(file, data),
      generate: input.generate, catalog: input.catalog, apply: (binding, target, signal) => this.configureTarget(binding, target, signal),
      progress: (threadId, text) => { this.store.appendMessage(threadId, { role: "bot", kind: "activity", text: `Pi / OhMyPi: ${text}` }); } });
    for (const [threadId, target] of Object.entries(this.management.targets)) this.sessions[threadId] = target.session.id;
  }

  private read(file: string): any {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 2_000_000) throw refuse("Invalid private OhMyPi settings");
    return JSON.parse(readFileSync(file, "utf8"));
  }

  private save(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink()) throw refuse("Native settings must not use a symlink");
    chmodSync(this.dir, 0o700);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temp, file);
  }

  private historyKey(threadId: string, sessionId: string): string {
    return createHash("sha256").update(JSON.stringify([threadId, sessionId])).digest("hex");
  }

  private validate(raw: any): { bindings: NativeOmpBinding[] } {
    if (!Array.isArray(raw?.bindings) || raw.bindings.length > 20) throw refuse("Invalid OhMyPi bindings");
    const seen = new Set<string>();
    return { bindings: raw.bindings.map((value: any): NativeOmpBinding => {
      if (!validId(value.botId) || seen.has(value.botId) || typeof value.enabled !== "boolean" || typeof value.profile !== "string" || typeof value.cwd !== "string" || typeof value.model !== "string") throw refuse("One explicit OhMyPi destination is required per Bot");
      seen.add(value.botId);
      nativeOmpCommand({ ...value, threadId: "validation" });
      for (const selection of [value.mediator, value.formatter].filter(Boolean)) {
        if (!validId(selection.providerId) || typeof selection.modelId !== "string" || !/^[\w./:-]{1,160}$/u.test(selection.modelId) || !Number.isInteger(selection.timeoutMs) || selection.timeoutMs < 1000 || selection.timeoutMs > 60_000) throw refuse("Invalid OhMyPi mediator model");
      }
      if (!value.mediator) throw refuse("NativeConnect requires an explicit mediator");
      if (value.connection !== undefined && value.connection !== "shared-tui") throw refuse("Invalid native connection mode");
      if (value.approvalPolicy !== undefined && !["human", "mediator"].includes(value.approvalPolicy)) throw refuse("Invalid native approval policy");
      if (value.advisor !== undefined && (typeof value.advisor !== "boolean" || value.connection !== "shared-tui")) throw refuse("Native advisor requires a shared TUI");
      return { botId: value.botId, enabled: value.enabled, host: value.host, user: value.user, binary: value.binary, stateRoot: value.stateRoot, profile: value.profile, cwd: value.cwd, model: value.model,
        ...(value.connection ? { connection: value.connection } : {}),
        ...(value.approvalPolicy ? { approvalPolicy: value.approvalPolicy } : {}),
        ...(value.advisor !== undefined ? { advisor: value.advisor } : {}),
        mediator: { ...value.mediator }, ...(value.formatter ? { formatter: { ...value.formatter } } : {}) };
    }) };
  }

  start(): void {
    for (const threadId of new Set([...Object.keys(this.sessions), ...Object.keys(this.management.targets)])) {
      const bot = this.store.botByThread(threadId), binding = bot && this.binding(bot.id, threadId);
      if (binding?.connection === "shared-tui") void this.sharedClient(binding).initialize().catch(() => { this.states.set(threadId, "disconnected"); this.scheduleReconnect(binding); });
    }
  }

  private scheduleReconnect(binding: Binding): void {
    if (this.closing || this.configuring.has(binding.threadId) || this.reconnectTimers.has(binding.threadId) || !this.binding(binding.botId, binding.threadId)) return;
    const attempt = this.reconnectAttempts.get(binding.threadId) ?? 0;
    this.reconnectAttempts.set(binding.threadId, Math.min(attempt + 1, 5));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(binding.threadId);
      if (this.closing || !this.binding(binding.botId, binding.threadId)) return;
      void this.sharedClient(binding).initialize().then(() => this.reconnectAttempts.delete(binding.threadId), () => this.scheduleReconnect(binding));
    }, Math.min(30000, 1000 * 2 ** attempt));
    timer.unref(); this.reconnectTimers.set(binding.threadId, timer);
  }

  private sharedClient(binding: Binding, prepared?: NativeOmpTransport): NativeOmpTransport {
    const current = this.clients.get(binding.threadId);
    if (!prepared && current && !(current as NativeOmpCollab).closed) return current;
    this.clients.delete(binding.threadId);
    const client = prepared ?? this.sharedOpen({ ...binding, expectedSessionId: binding.expectedSessionId ?? this.sessions[binding.threadId] });
    this.clients.set(binding.threadId, client);
    const approvals: Active = { controller: new AbortController(), source: { id: `native-host-${binding.threadId}`, text: "" }, client, questions: new Set(), cards: new Map(), stopped: false };
    let lastNotice = "";
    client.on("nativeNotice", ({ code, admitted }: { code: string; admitted: boolean }) => {
      if (this.closing || this.clients.get(binding.threadId) !== client || code !== "host-operation-error") return;
      const key = this.active.get(binding.threadId)?.source.id ?? approvals.source.id;
      if (this.ledger[key]) { this.ledger[key].failure = { phase: "native-notice", status: admitted ? "accepted" : "unconfirmed" }; this.save(this.ledgerFile, this.ledger); }
      if (lastNotice === key) return;
      lastNotice = key;
      this.store.appendMessage(binding.threadId, { role: "bot", kind: "activity", text: "Pi / OhMyPi: 操作エラーの通知を受けました。依頼の受理状態と履歴の確認を続けています。再送はしていません。" });
    });
    let recoveredFinal: { entryId: string; sessionId: string; text: string } | undefined;
    const recoverFinal = () => {
      const key = approvals.source.id, receipt = this.ledger[key];
      if (!recoveredFinal || this.active.has(binding.threadId) || !receipt || !["submitted", "indeterminate"].includes(receipt.stage)) return;
      const reply = this.store.messagesFor(binding.threadId).find(message => message.nativeOmp?.entryId === recoveredFinal!.entryId);
      if (!reply) return;
      this.store.patchMessage(binding.threadId, reply.id, {
        requestMessageId: key, turnId: reply.turnId ?? `omp-${key}`, turnSucceeded: true, turnTerminal: true, turnCompletedAt: Date.now(),
        nativeOmp: { sessionId: recoveredFinal.sessionId, requestId: key, entryId: recoveredFinal.entryId, originalText: recoveredFinal.text },
      });
      receipt.stage = "completed"; this.save(this.ledgerFile, this.ledger);
      this.store.patchMessage(binding.threadId, key, { requestPending: false });
      recoveredFinal = undefined; this.progress.delete(binding.threadId); this.audits.delete(binding.threadId);
    };
    this.sharedQuestions.set(binding.threadId, approvals);
    client.on("nativeTool", (event: NativeToolProgress) => {
      if (!this.closing && this.clients.get(binding.threadId) === client) this.progressTool(binding, approvals.source, event);
    });
    client.on("question", (question: OmpQuestion) => {
      const receipt = this.ledger[approvals.source.id];
      const recovered = approvals.source.text && receipt && ["submitted", "indeterminate", "completed"].includes(receipt.stage) && !this.store.messagesFor(binding.threadId).find(message => message.id === approvals.source.id)?.requestCancelled ? approvals : undefined;
      const active = this.active.get(binding.threadId);
      void this.question(binding, approvals, question, active?.source.id === approvals.source.id ? active : recovered);
    });
    client.on("questionCancelled", (id: string) => {
      approvals.questions.delete(id);
      for (const [requestId, pending] of approvals.cards) if (pending.nativeId === id) this.expire(binding.threadId, approvals, requestId);
    });
    client.on("nativeEntry", (event: { entryId: string; role?: string; text: string; own: boolean; activeOwn: boolean; snapshot: boolean; sessionId: string; stopReason?: string }) => {
      if (this.closing || this.clients.get(binding.threadId) !== client || (this.sessions[binding.threadId] && event.sessionId !== this.sessions[binding.threadId])) return;
      if (!event.entryId || !["user", "assistant"].includes(event.role ?? "") || !event.text) return;
      if (event.role === "user") {
        recoverFinal(); recoveredFinal = undefined;
        const candidates = event.own ? this.store.messagesFor(binding.threadId).filter(message => {
          const receipt = this.ledger[message.id];
          return message.role === "user" && message.text === event.text && receipt?.sessionId === event.sessionId &&
            !message.requestCancelled && ["submitted", "indeterminate", "completed"].includes(receipt.stage) && (!receipt.admissionEntryId || receipt.admissionEntryId === event.entryId) &&
            receipt.digest === createHash("sha256").update(JSON.stringify([binding.botId, binding.threadId, event.text])).digest("hex");
        }) : [];
        const current = candidates.find(message => message.id === this.active.get(binding.threadId)?.source.id);
        const source = current ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (source && !this.ledger[source.id]!.admissionEntryId) { this.ledger[source.id]!.admissionEntryId = event.entryId; this.save(this.ledgerFile, this.ledger); }
        if (!source || this.consent.get(binding.threadId)?.requestId && this.consent.get(binding.threadId)?.requestId !== source.id) this.consent.delete(binding.threadId);
        approvals.source = source || { id: `native-host-${binding.threadId}`, text: "" };
        if (source && !event.snapshot) this.progressStatus(binding, source, "OhMyPiが依頼を受け取り、処理を進めています。");
      }
      if (event.role === "assistant" && event.stopReason === "stop" && approvals.source.text && !this.active.has(binding.threadId)) recoveredFinal = event;
      const seen = this.observed[this.historyKey(binding.threadId, event.sessionId)] ??= [];
      if (seen.includes(event.entryId)) return;
      if (event.role === "assistant" && event.stopReason !== "stop" && !event.snapshot && approvals.source.text) {
        const progress = this.progressFor(binding, approvals.source);
        this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: event.text, requestMessageId: approvals.source.id, turnId: progress.turnId,
          nativeOmp: { sessionId: event.sessionId, requestId: approvals.source.id, entryId: event.entryId, originalText: event.text } });
      }
      if (seen.length >= 10_000) { client.close(); this.states.set(binding.threadId, "history-review-required"); return; }
      seen.push(event.entryId);
      const existing = this.store.messagesFor(binding.threadId);
      const oldEnvelope = event.text.match(/"request_id":"([\w-]+)"/u)?.[1];
      const isExisting = existing.some(m => m.nativeOmp?.sessionId === event.sessionId && m.nativeOmp.entryId === event.entryId) || event.snapshot &&
        (existing.some(m => m.nativeOmp?.sessionId === event.sessionId && m.role === (event.role === "user" ? "user" : "bot") && (m.text === event.text || m.nativeOmp.originalText === event.text)) || Boolean(oldEnvelope && this.ledger[oldEnvelope]?.sessionId === event.sessionId));
      if (!isExisting && !event.own && !(event.activeOwn && event.role === "assistant") && !(event.role === "assistant" && event.stopReason !== "stop" && !event.snapshot && approvals.source.text)) {
        this.store.appendMessage(binding.threadId, { role: event.role === "user" ? "user" : "bot", kind: "text", text: event.text,
          ...(event.role === "assistant" && event.stopReason === "stop" && approvals.source.text ? { requestMessageId: approvals.source.id, turnId: this.progress.get(binding.threadId)?.turnId ?? `omp-${approvals.source.id}`, turnTerminal: true } : {}),
          nativeOmp: { sessionId: event.sessionId, requestId: approvals.source.text ? approvals.source.id : `native-entry-${event.entryId}`, entryId: event.entryId, originalText: event.text, ...(approvals.source.text ? {} : { source: "human" as const }) } });
      }
      this.save(this.observedFile, this.observed);
    });
    client.on("nativeState", ({ busy, reconnecting }: { busy: boolean; reconnecting?: boolean }) => {
      if (this.closing || this.clients.get(binding.threadId) !== client) return;
      this.nativeBusy.set(binding.threadId, busy);
      if (!busy) { recoverFinal(); this.progress.delete(binding.threadId); if (!this.active.has(binding.threadId) && this.consent.get(binding.threadId)?.requestId) this.consent.delete(binding.threadId); }
      if (!this.active.has(binding.threadId)) {
        this.states.set(binding.threadId, reconnecting ? "reconnecting" : busy ? "human-working" : "idle");
        this.store.setTaskActivity(binding.botId, binding.threadId, approvals.cards.size ? "waiting-on-you" : busy ? "working" : "idle");
        if (!busy) this.settled();
      }
    });
    client.on("reconnecting", () => {
      if (this.closing || this.clients.get(binding.threadId) !== client) return;
      this.consent.delete(binding.threadId);
      this.states.set(binding.threadId, "reconnecting");
      this.store.appendMessage(binding.threadId, { role: "bot", kind: "activity", text: "Pi / OhMyPi: 共有接続を復旧し、履歴を照合しています。送信済みの依頼は再送しません。" });
    });
    client.on("disconnected", () => {
      if (this.closing || this.clients.get(binding.threadId) !== client) return;
      this.consent.delete(binding.threadId);
      approvals.stopped = true; approvals.controller.abort();
      for (const id of approvals.cards.keys()) this.expire(binding.threadId, approvals, id);
      if (this.sharedQuestions.get(binding.threadId) === approvals) this.sharedQuestions.delete(binding.threadId);
      this.nativeBusy.delete(binding.threadId);
      this.clients.delete(binding.threadId); this.states.set(binding.threadId, "disconnected");
      if (!this.active.has(binding.threadId)) this.store.setTaskActivity(binding.botId, binding.threadId, "idle");
      this.scheduleReconnect(binding);
    });
    return client;
  }

  binding(botId: string, threadId: string): Binding | undefined {
    const binding = this.settings.bindings.find(item => item.enabled && item.botId === botId);
    if (!binding || !this.store.taskByThread(botId, threadId)) return undefined;
    return { ...binding, ...this.management.destination({ ...binding, threadId }), threadId, ...(this.management.targets[threadId] ? { connection: "shared-tui" as const } : {}) };
  }

  private async configureTarget(binding: Binding, target: NativeOmpThreadTarget, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const threadId = binding.threadId;
    if (this.configuring.has(threadId) || this.nativeBusy.get(threadId) || this.active.get(threadId)?.client || this.sharedQuestions.get(threadId)?.cards.size) throw refuse("接続元の会話は実行中か確認待ちです。終了後に接続を変更できます。");
    const previous = { client: this.clients.get(threadId), questions: this.sharedQuestions.get(threadId), session: this.sessions[threadId], state: this.states.get(threadId), busy: this.nativeBusy.get(threadId), activity: this.store.taskByThread(binding.botId, threadId)?.activity ?? "idle" };
    this.configuring.add(threadId);
    clearTimeout(this.reconnectTimers.get(threadId)); this.reconnectTimers.delete(threadId); this.reconnectAttempts.delete(threadId);
    const next = { ...binding, sessionDir: target.session.directory, sessionFile: target.session.file, cwd: target.session.cwd ?? binding.cwd, expectedSessionId: target.session.id };
    let client: NativeOmpTransport | undefined;
    try {
      this.sessions[threadId] = target.session.id;
      client = this.sharedOpen(next); this.sharedClient(next, client);
      const initialized = client.initialize();
      const session = await new Promise<Awaited<ReturnType<NativeOmpTransport["initialize"]>>>((resolve, reject) => {
        const abort = () => reject(Error("OMPへの接続変更を停止しました。"));
        signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
        initialized.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
      });
      signal?.throwIfAborted();
      if (session.sessionId !== target.session.id) throw refuse("選択したOMPセッションと接続先が一致しません。");
      this.save(this.sessionsFile, this.sessions); this.save(this.observedFile, this.observed);
      if (previous.client !== client) previous.client?.close();
      this.states.set(threadId, this.nativeBusy.get(threadId) ? "human-working" : "idle");
    } catch (error) {
      if (previous.session) this.sessions[threadId] = previous.session; else delete this.sessions[threadId];
      if (previous.client) this.clients.set(threadId, previous.client); else this.clients.delete(threadId);
      if (previous.questions) this.sharedQuestions.set(threadId, previous.questions); else this.sharedQuestions.delete(threadId);
      if (previous.busy !== undefined) this.nativeBusy.set(threadId, previous.busy); else this.nativeBusy.delete(threadId);
      this.states.set(threadId, previous.state ?? "disconnected"); client?.close();
      this.store.setTaskActivity(binding.botId, threadId, previous.activity);
      const old = previous.client as NativeOmpCollab | undefined;
      if (old && !old.closed && typeof old.reconnect === "function") old.reconnect();
      throw error;
    } finally { this.configuring.delete(threadId); }
  }

  ownerConsent(botId: string, threadId: string, text: string, sendId?: string, sender?: Message["sender"]): Message | undefined {
    const binding = this.binding(botId, threadId), command = nativeConsentCommand(text);
    if (!binding || binding.approvalPolicy !== "mediator" || !command) return undefined;
    const messages = this.store.messagesFor(threadId);
    const duplicate = sendId && messages.find(message => message.sendId === sendId);
    if (duplicate) {
      if (duplicate.text !== text) throw refuse("この送信IDは別の入力で使用済みです。");
      return duplicate;
    }
    const active = this.active.get(threadId);
    const shared = this.sharedQuestions.get(threadId);
    const source = active?.source ?? (shared?.source.text && this.nativeBusy.get(threadId) ? shared.source : undefined);
    const sourceMessage = source && messages.find(message => message.id === source.id);
    if (command === "grant" && this.nativeBusy.get(threadId) && (!source || sourceMessage?.requestCancelled)) throw refuse("人間が標準TUIで操作中です。BOTの依頼への切り替え後に許可してください。");
    const message = this.store.appendMessage(threadId, { role: "user", kind: "text", text, sendId, sender });
    if (command === "revoke") this.consent.delete(threadId);
    else this.consent.set(threadId, { requestId: source?.id, expiresAt: Date.now() + (source ? 24 * 60 * 60_000 : 10 * 60_000) });
    this.store.appendMessage(threadId, { role: "bot", kind: "activity", text: command === "revoke"
      ? "今回の一括許可を取り消しました。以後の高リスク操作は確認します。既に開始した操作は取り消されません。"
      : source ? "今回の依頼の操作をすべて許可しました。高リスク操作は実行状況をカードで記録します。完了・停止・接続解除で許可を解除します。"
      : "次の依頼1件の操作をすべて許可します。10分以内の次の依頼に適用し、完了・停止・接続解除で解除します。" });
    if (command === "grant" && source) {
      for (const job of [active, shared]) if (job) for (const [id, pending] of job.cards) {
        if (!nativeToolApproval(pending.question) || pending.card.requestMessageId !== source.id) continue;
        this.expire(threadId, job, id); job.questions.delete(pending.nativeId);
        void this.question(binding, job, pending.question, active ?? shared);
      }
    }
    return message;
  }

  private hasConsent(threadId: string, requestId: string): boolean {
    const consent = this.consent.get(threadId);
    if (consent && consent.expiresAt <= Date.now()) this.consent.delete(threadId);
    return Boolean(consent && consent.expiresAt > Date.now() && consent.requestId === requestId);
  }

  private auditPermission(binding: Binding, question: OmpQuestion, reason: string, client: NativeOmpTransport): void {
    const operation = (client as NativeOmpCollab).pendingOperation?.(question);
    const raw = question.message ?? question.title ?? "";
    const name = operation?.name ?? question.title?.split("\n")[0]?.replace("Allow tool: ", "") ?? "操作";
    const summary = japanesePermissionDetail(question).split(/\n内容:|\n変更前:|\n変更後:/u)[0]!;
    const row = this.store.appendMessage(binding.threadId, { role: "bot", kind: "options", card: {
      title: "高リスク操作の実行記録", subtitle: nativeAuditText(`今回の一括許可によりLunaが許可しました。\n${reason}\n${summary}`) + "\n状態: 実行許可済み・開始は未確認",
      options: [], requestId: `native-omp-audit-${randomUUID()}`, requestType: "permission", tool: `OhMyPi/${name}`, answered: "allow",
    } });
    const audits = this.audits.get(binding.threadId) ?? [];
    audits.push({ row, name, callId: operation?.id, command: name === "bash" ? raw.match(/^Command: ([\s\S]+)$/mu)?.[1] : undefined, started: false }); this.audits.set(binding.threadId, audits);
  }

  private auditProgress(threadId: string, event: NativeToolProgress): void {
    const audits = this.audits.get(threadId) ?? [];
    const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : undefined;
    const matching = audits.filter(audit => audit.callId ? audit.callId === event.toolCallId : audit.name === event.toolName && audit.command && args?.command === audit.command);
    if (matching.length !== 1) return;
    const audit = matching[0]!;
    if (event.type === "tool_execution_start") { audit.started = true; audit.callId ??= event.toolCallId; }
    if (event.type === "tool_execution_end" && !audit.started && !audit.callId) return;
    const status = event.type === "tool_execution_start" ? "実行開始を確認" : event.isError === true ? "実行終了（エラー）" : event.isError === false ? "実行終了（ツールの正常終了を確認）" : "実行終了（成否は未確認）";
    audit.row.card!.subtitle = audit.row.card!.subtitle.replace(/状態: [^\n]*$/u, `状態: ${status}`);
    this.store.patchMessage(threadId, audit.row.id, { card: { ...audit.row.card! } });
    if (event.type === "tool_execution_end") this.audits.set(threadId, audits.filter(item => item !== audit));
  }

  dispatch(binding: Binding, text: string, fields: Pick<Message, "sendId" | "sender" | "via" | "callId"> = {}, existingSource?: Message, onSettled?: () => void): Message {
    if (!this.binding(binding.botId, binding.threadId) || this.active.has(binding.threadId)) throw refuse("Native OhMyPi session is unavailable or busy");
    if (this.store.taskByThread(binding.botId, binding.threadId)?.busy) throw refuse("Native OhMyPi session is busy");
    if (!text.trim() || text.length > 100_000 || /<attached-(?:image|file|audio)\b|\[.*?\]\((?:attachment:|\/?api\/attachments\/)|data:(?:image|audio)\//iu.test(text)) throw refuse("Native OhMyPi currently accepts plain text only");
    if (Object.keys(this.ledger).length >= 5000) throw refuse("Native request ledger needs owner review before further submissions");
    const source = existingSource ?? this.store.appendMessage(binding.threadId, { role: "user", kind: "text", text, ...fields, requestPending: true });
    if (existingSource) this.store.patchMessage(binding.threadId, source.id, { requestPending: true });
    this.audits.delete(binding.threadId);
    const job: Active = { controller: new AbortController(), source, questions: new Set(), cards: new Map(), stopped: false, onSettled };
    const consent = this.consent.get(binding.threadId);
    if (consent && !consent.requestId && consent.expiresAt > Date.now()) consent.requestId = source.id;
    else this.consent.delete(binding.threadId);
    this.active.set(binding.threadId, job); this.states.set(binding.threadId, "preparing");
    this.store.setTaskActivity(binding.botId, binding.threadId, "working");
    void this.run(binding, text, job);
    return source;
  }

  private async run(binding: Binding, text: string, job: Active): Promise<void> {
    let submitted = false;
    let ownsReceipt = false;
    let phase = "prepare";
    const key = job.source.id;
    const timeout = binding.connection === "shared-tui" ? undefined : setTimeout(() => { job.controller.abort(); job.client?.close(); }, 15 * 60_000); timeout?.unref();
    try {
      const digest = createHash("sha256").update(JSON.stringify([binding.botId, binding.threadId, text])).digest("hex");
      if (this.ledger[key]) throw refuse("This native request already has a receipt; do not resend automatically");
      this.ledger[key] = { digest, stage: "prepared" }; this.save(this.ledgerFile, this.ledger);
      ownsReceipt = true;
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(binding.mediator.timeoutMs)]);
      const preparation = await this.management.prepare(binding, text, signal);
      const note = preparation.note;
      signal.throwIfAborted();
      if (typeof note !== "string" || !note.trim() || note.length > 4000) throw refuse("Invalid mediator output");
      job.controller.signal.throwIfAborted();
      if (preparation.plan.action !== "chat") {
        phase = "management";
        const result = await this.management.execute(binding, key, preparation.plan, job.controller.signal);
        this.ledger[key].stage = "completed"; this.save(this.ledgerFile, this.ledger);
        this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: result, requestMessageId: key, turnId: `omp-${key}`, turnSucceeded: true, turnTerminal: true, turnCompletedAt: Date.now() });
        this.states.set(binding.threadId, "idle"); return;
      }
      phase = "connect";
      const client = job.client = binding.connection === "shared-tui" ? this.sharedClient(binding) : this.open(binding);
      if (binding.connection !== "shared-tui") {
        client.on("question", (question: OmpQuestion) => { void this.question(binding, job, question); });
        client.on("questionCancelled", (id: string) => {
          job.questions.delete(id);
          for (const [requestId, pending] of job.cards) if (pending.nativeId === id) this.expire(binding.threadId, job, requestId);
        });
      }
      if (binding.connection !== "shared-tui") {
        client.on("nativeTool", (event: NativeToolProgress) => this.progressTool(binding, job.source, event));
        client.on("nativeNarration", (event: { text: string }) => {
          const progress = this.progressFor(binding, job.source);
          this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: event.text, requestMessageId: key, turnId: progress.turnId });
        });
      }
      phase = "initialize";
      const session = await client.initialize();
      phase = "identity";
      if (this.sessions[binding.threadId] && this.sessions[binding.threadId] !== session.sessionId) throw refuse("Native conversation identity changed; owner review required");
      this.sessions[binding.threadId] = session.sessionId; this.save(this.sessionsFile, this.sessions);
      job.controller.signal.throwIfAborted();
      this.ledger[key] = { digest, stage: "submitted", sessionId: session.sessionId }; this.save(this.ledgerFile, this.ledger);
      submitted = true; this.states.set(binding.threadId, "working");
      phase = "submit";
      const nativeText = binding.connection === "shared-tui" ? text : "OpenMausBot経由のユーザー依頼です。user_requestが原文で、mediator_noteは補助メモです。原文にない権限を追加せず、ネイティブの承認を維持してください。\n" + JSON.stringify({ request_id: key, user_request: text, mediator_note: note.trim() });
      const result = await client.submit(key, nativeText);
      const metadata = { sessionId: result.sessionId, requestId: key, originalText: result.text, ...(result.sharedTurn ? { sharedTurn: true } : {}) };
      const displayText = result.sharedTurn ? "共有ターンの応答です。標準TUIからの入力も同じターンに含まれています。\n\n" + result.text : result.text;
      this.ledger[key].stage = "completed"; this.save(this.ledgerFile, this.ledger);
      const reply = this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: displayText, requestMessageId: key,
        turnId: this.progress.get(binding.threadId)?.turnId ?? `omp-${key}`, turnSucceeded: true, turnTerminal: true, turnCompletedAt: Date.now(), nativeOmp: metadata });
      this.progress.delete(binding.threadId); this.consent.delete(binding.threadId); this.audits.delete(binding.threadId);
      this.states.set(binding.threadId, "idle");
      void presentDirectReply(text, displayText, this.formatter, binding.formatter).then(presentation => {
        if (this.store.taskByThread(binding.botId, binding.threadId)) this.store.patchMessage(binding.threadId, reply.id,
          { text: result.sharedTurn && !presentation.text.startsWith("共有ターン") ? "共有ターンの応答です。標準TUIからの入力も含まれています。\n\n" + presentation.text : presentation.text, nativeOmp: { ...metadata, formatted: presentation.formatted, formatterFailure: presentation.failure } });
      }).catch(() => {});
    } catch (error) {
      const queued = binding.connection === "shared-tui" && (job.client as NativeOmpCollab | undefined)?.requestStatus?.(key) === "queued";
      if (queued) submitted = false;
      if (ownsReceipt && (this.ledger[key]?.stage === "prepared" || this.ledger[key]?.stage === "submitted")) {
        this.ledger[key].stage = submitted ? "indeterminate" : "not-sent";
        this.ledger[key].failure = { phase, status: binding.connection === "shared-tui" ? (job.client as NativeOmpCollab | undefined)?.requestStatus?.(key) : undefined };
        this.save(this.ledgerFile, this.ledger);
      }
      this.states.set(binding.threadId, job.stopped ? "stopped" : submitted ? "indeterminate" : `not-sent:${phase}`);
      this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: phase === "management"
        ? `OMPのセッション管理を完了できませんでした。${error instanceof Error ? error.message.slice(0, 500) : "接続状態を確認しています。"} 元の会話は削除していません。自動で別セッションを作り直していません。`
        : submitted
        ? "Piへの依頼は送信済みですが、中継で完了を確認できませんでした。同じ会話への接続と履歴の照合を続けています。依頼は再送していません。停止した場合も、停止完了を確認するまでは未確認として扱います。"
        : queued ? "Pi側の処理・承認待ちで、この入力はまだ送信していません。自動再送はしていません。"
        : "仲介処理またはPiのOhMyPiへの接続に失敗したため、依頼本文は送信していません。認証と接続設定を確認してください。",
      requestMessageId: key, turnId: `omp-${key}`, turnSucceeded: false, turnTerminal: true, turnCompletedAt: Date.now() });
    } finally {
      clearTimeout(timeout);
      if (job.stopped || this.ledger[key]?.stage !== "indeterminate") this.consent.delete(binding.threadId);
      if (binding.connection === "shared-tui" && (job.client as NativeOmpCollab | undefined)?.closed) this.scheduleReconnect(binding);
      job.controller.abort();
      if (binding.connection !== "shared-tui") job.client?.close();
      if (binding.connection !== "shared-tui") { job.client?.removeAllListeners("question"); job.client?.removeAllListeners("questionCancelled"); }
      if (binding.connection !== "shared-tui") { job.client?.removeAllListeners("nativeTool"); job.client?.removeAllListeners("nativeNarration"); }
      for (const id of job.cards.keys()) this.expire(binding.threadId, job, id);
      this.store.patchMessage(binding.threadId, key, { requestPending: false, ...(job.stopped ? { requestCancelled: true } : {}) });
      this.active.delete(binding.threadId);
      const activity = this.sharedQuestions.get(binding.threadId)?.cards.size ? "waiting-on-you" : this.nativeBusy.get(binding.threadId) ? "working" : "idle";
      if (activity !== "idle") this.states.set(binding.threadId, activity === "working" ? "human-working" : activity);
      this.store.setTaskActivity(binding.botId, binding.threadId, activity); job.onSettled?.(); this.settled();
    }
  }

  private progressFor(binding: Binding, source: Pick<Message, "id" | "text">): NativeProgress {
    const current = this.progress.get(binding.threadId);
    if (current?.requestId === source.id) return current;
    const settled = this.store.messagesFor(binding.threadId).some(message => message.requestMessageId === source.id && message.turnTerminal);
    const progress = { requestId: source.id, turnId: `omp-${source.id}${settled ? `-${randomUUID()}` : ""}`, completed: [] };
    this.progress.set(binding.threadId, progress); return progress;
  }

  private progressStatus(binding: Binding, source: Pick<Message, "id" | "text">, text: string, completed = false): void {
    if (!source.text) return;
    const progress = this.progressFor(binding, source);
    if (completed) { progress.completed.push(text); progress.completed = progress.completed.slice(-5); }
    const body = ["Pi / OhMyPi の途中経過", text, ...progress.completed.filter(line => line !== text).map(line => `・${line}`)].join("\n");
    if (progress.rowId && this.store.patchMessage(binding.threadId, progress.rowId, { text: body })) return;
    progress.rowId = this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: body, requestMessageId: source.id, turnId: progress.turnId }).id;
  }

  private progressTool(binding: Binding, source: Pick<Message, "id" | "text">, event: NativeToolProgress): void {
    this.auditProgress(binding.threadId, event);
    const names: Record<string, string> = { read: "ファイル・情報の確認", grep: "内容の検索", glob: "ファイルの検索", bash: "コマンド・検証の実行", write: "ファイルの保存", edit: "ファイルの編集" };
    const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
    const path = typeof args.path === "string" && !/^https?:/u.test(args.path) ? basename(args.path).slice(0, 100) : undefined;
    const command = typeof args.command === "string" ? args.command : "";
    let name = names[event.toolName ?? ""] ?? "ツールの実行";
    if (event.toolName === "bash" && /unittest|pytest/u.test(command)) name = "単体テスト";
    else if (event.toolName === "bash" && /smoke|verify/u.test(command)) name = "動作検証";
    else if (event.toolName === "bash" && /^curl\s/u.test(command)) name = "APIの疎通確認";
    if (path) name += `（${path}）`;
    this.progressStatus(binding, source, `${name}${event.type === "tool_execution_start" ? "を進めています。" : event.isError ? "でエラーが出ました。" : "が終わりました。"}`, event.type === "tool_execution_end");
  }

  private async question(binding: Binding, job: Active, question: OmpQuestion, reviewJob?: Active): Promise<void> {
    const owns = () => this.active.get(binding.threadId) === job || this.sharedQuestions.get(binding.threadId) === job;
    if (!owns()) return;
    if (job.questions.has(question.id)) return;
    job.questions.add(question.id);
    const decline = automaticReportDecline(question);
    if (decline) {
      try {
        job.client!.answerUi(question.id, decline);
        this.store.appendMessage(binding.threadId, { role: "bot", kind: "activity", text: "Pi / OhMyPi: 開発元への自動不具合報告を辞退しました。外部へ報告は送信していません。" });
      } catch { /* The native TUI may have answered while the report was being declined. */ }
      finally { job.questions.delete(question.id); }
      return;
    }
    const reviewer = reviewJob ?? (this.active.get(binding.threadId) === job ? job : undefined);
    const toolApproval = nativeToolApproval(question);
    const ownerRequestId = job.source.id, reviewRequestId = reviewer?.source.id, reviewText = reviewer?.source.text ?? "";
    const current = () => owns() && !job.stopped && !reviewer?.stopped && !job.controller.signal.aborted && !reviewer?.controller.signal.aborted && job.questions.has(question.id) && job.source.id === ownerRequestId && reviewer?.source.id === reviewRequestId;
    let risk: NativeRiskDecision = { kind: "high-risk", reason: "この接続は本人が許可する設定です。" };
    if (binding.approvalPolicy === "mediator" && toolApproval) {
      if (!reviewer) return;
      const messages = this.store.messagesFor(binding.threadId);
      const sourceIndex = messages.findIndex(message => message.id === reviewRequestId);
      const sessionId = this.ledger[reviewer.source.id]?.sessionId;
      const priorRequests = sourceIndex < 0 ? [] : messages.slice(0, sourceIndex).filter(message => message.role === "user" && !message.nativeOmp && this.ledger[message.id]?.sessionId === sessionId).slice(-8).map(message => message.text ?? "");
      const humanApprovals = sourceIndex < 0 ? [] : messages.slice(sourceIndex + 1).filter(message => message.card?.requestType === "permission" && message.card.answered === "allow" &&
        (message.requestMessageId ? message.requestMessageId === reviewRequestId : !messages.some(next => next.role === "user" && !next.nativeOmp && next.at > messages[sourceIndex]!.at && next.at < message.at)))
        .map(message => message.card!.subtitle ?? "");
      const native = job.client as NativeOmpCollab | undefined;
      const signal = AbortSignal.any([job.controller.signal, reviewer.controller.signal]);
      let attempts = 0;
      while (current()) {
        const operation = native?.pendingOperation?.(question);
        let files = native?.recentFileWrites?.();
        if (native?.reviewFiles) {
          try { files = await native.reviewFiles(question, AbortSignal.any([signal, AbortSignal.timeout(12_000)])); }
          catch { files = []; }
        }
        if (!current()) return;
        risk = await classifyNativeRisk(binding, reviewText, question, this.generate, signal, { priorRequests, files, operation, humanApprovals });
        if (!current()) return;
        if (risk.kind !== "retry") break;
        this.progressStatus(binding, reviewer.source, "高リスク判定を再試行しています。操作はまだ実行していません。");
        this.states.set(binding.threadId, "working"); this.store.setTaskActivity(binding.botId, binding.threadId, "working");
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5))); timer.unref();
          signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
        });
      }
      if (!current()) return;
      const delegated = risk.kind === "high-risk" && this.hasConsent(binding.threadId, reviewer.source.id);
      if (risk.kind === "proceed" || delegated) {
        try {
          if (delegated && risk.kind === "high-risk") this.auditPermission(binding, question, risk.reason, job.client!);
          job.client!.answerUi(question.id, { value: "Approve" }); job.questions.delete(question.id);
          this.progressStatus(binding, reviewer.source, delegated ? "今回の一括許可に基づき、高リスク操作を進めています。内容と実行状況をカードに記録しました。" : "高リスクは検出されなかったため、操作を進めています。");
        } catch { job.questions.delete(question.id); }
        return;
      }
    }
    if (!owns() || job.stopped || !job.questions.has(question.id)) return;
    if (toolApproval && reviewer && risk.kind === "high-risk") this.progressStatus(binding, reviewer.source, `本人の確認を待っています。${risk.reason}`);
    const id = `native-omp-${randomUUID()}`;
    // OhMyPi 18.12.5 emits native tool approvals as select dialogs; never expose its session-wide approval option.
    const allowValue = nativeToolApproval(question) ? "Approve" : undefined;
    const permission = question.method === "confirm" || allowValue !== undefined;
    const reason = risk.kind === "high-risk" ? `高リスクのため確認します。${risk.reason}` : "";
    const presentation = allowValue ? { text: `${reason}\n\n${japanesePermissionDetail(question)}`, labels: [], translated: true }
      : await japaneseNativeQuestion(binding, question, this.generate, job.controller.signal);
    if (!owns() || job.stopped || !job.questions.has(question.id)) return;
    const choices = new Map(presentation.labels.map((label, index) => [label, question.options![index]!]));
    const card = this.store.appendMessage(binding.threadId, { role: "bot", kind: "options", ...(reviewer ? { requestMessageId: reviewer.source.id } : {}), card: {
      title: permission ? "Pi / OhMyPiの操作許可" : "Pi / OhMyPiからの確認",
      subtitle: presentation.text,
      options: permission ? ["許可", "拒否"] : presentation.labels, requestId: id, requestType: permission ? "permission" : "question",
      ...(permission ? { tool: `OhMyPi/${question.method}` } : { questionRequest: { version: 1 as const, questions: [{ question: presentation.text, options: presentation.labels.map(label => ({ label })), ...(question.method === "select" ? { custom: false as const } : {}) }] } }),
    } });
    job.cards.set(id, { nativeId: question.id, question, card, choices, ...(allowValue ? { allowValue } : {}) });
    this.states.set(binding.threadId, "waiting-on-you");
    this.store.setTaskActivity(binding.botId, binding.threadId, "waiting-on-you");
  }

  private expire(threadId: string, job: Active, id: string): void {
    const pending = job.cards.get(id); if (!pending) return;
    job.cards.delete(id); this.store.patchMessage(threadId, pending.card.id, { card: { ...pending.card.card!, expired: true } });
  }

  answer(threadId: string, requestId: string, behavior: string, text?: string): RequestOutcome | undefined {
    const job = [this.active.get(threadId), this.sharedQuestions.get(threadId)].find(item => item?.cards.has(requestId)), pending = job?.cards.get(requestId);
    if (!job || !pending) return requestId.startsWith("native-omp-") ? "unavailable" : undefined;
    const permission = pending.question.method === "confirm" || pending.allowValue !== undefined;
    if (permission ? !["allow", "deny"].includes(behavior) : behavior !== "answer" || !text?.trim()) return "unavailable";
    let value = text;
    if (!permission && pending.card.card?.questionRequest) {
      const questions = pending.card.card.questionRequest.questions;
      const parsed = questionAnswersByQuestion(text!, questions)[questions[0]!.question] ?? text!;
      value = pending.choices?.get(parsed) ?? parsed;
      if (pending.question.method === "select" && !pending.question.options?.includes(value)) return "unavailable";
    }
    try { job.client!.answerUi(pending.nativeId, pending.allowValue ? { value: behavior === "allow" ? pending.allowValue : "Deny" } : permission ? { confirmed: behavior === "allow" } : { value: value! }); }
    catch { this.expire(threadId, job, requestId); return "unavailable"; }
    job.cards.delete(requestId);
    job.questions.delete(pending.nativeId);
    this.store.patchMessage(threadId, pending.card.id, { card: { ...pending.card.card!, answered: behavior, ...(text ? { answeredText: text } : {}) } });
    this.store.setTaskActivity(this.store.botByThread(threadId)!.id, threadId, job.cards.size ? "waiting-on-you" : "working");
    return permission ? behavior === "allow" ? "allowed-once" : "rejected" : "answered";
  }

  async stop(threadId: string): Promise<boolean> {
    this.consent.delete(threadId);
    const job = this.active.get(threadId); if (!job) return false;
    job.stopped = true; job.controller.abort();
    if (job.client) {
      try { await job.client.stop(); } finally { job.client.close(); }
    }
    return true;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer); this.reconnectTimers.clear();
    for (const [id, job] of this.active) {
      const bot = this.store.botByThread(id);
      if (bot && this.binding(bot.id, id)?.connection === "shared-tui") job.controller.abort();
      else void this.stop(id);
    }
    for (const [threadId, job] of this.sharedQuestions) { job.stopped = true; job.controller.abort(); for (const id of job.cards.keys()) this.expire(threadId, job, id); }
    for (const client of this.clients.values()) client.close(); this.clients.clear(); this.sharedQuestions.clear();
    this.progress.clear(); this.consent.clear(); this.audits.clear();
    this.pool.close();
  }

  route: RouteHandler = async ({ path, method, auth, json, req, res, readBody }) => {
    if (!["/api/native-omp", "/api/native-omp/sessions", "/api/native-omp/threads"].includes(path)) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Owner scope required" });
    res.setHeader("Cache-Control", "no-store");
    if (path !== "/api/native-omp") {
      try {
        const body = method === "GET" ? Object.fromEntries(new URL(req.url!, "http://localhost").searchParams) : await readBody(req);
        const bot = this.store.bot(body.botId), threadId = body.threadId ?? bot?.threadId;
        const binding = bot && this.binding(bot.id, threadId);
        if (!binding) return json(res, 404, { error: "有効なOMP接続先とBotのスレッドを選んでください。" });
        if (path === "/api/native-omp/sessions" && method === "GET") return json(res, 200, { sessions: await this.management.list(binding) });
        if (path === "/api/native-omp/sessions" && method === "POST") return json(res, 200, { session: await this.management.create(binding, body.name, body.requestId) });
        if (path === "/api/native-omp/threads" && method === "POST" && ["session", "manager"].includes(body.kind)) {
          if (body.newThreadTitle !== undefined && (typeof body.newThreadTitle !== "string" || !body.newThreadTitle.trim() || body.newThreadTitle.length > 120 || /[\p{Cc}]/u.test(body.newThreadTitle))) throw refuse("新しいスレッド名が不正です。");
          return json(res, 200, await this.management.connect(binding, body.sessionId, body.kind, body.newThreadTitle, body.requestId));
        }
        return json(res, 405, { error: "この操作には対応していません。" });
      } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "OMPの接続を変更できません。" }); }
    }
    if (method === "GET") return json(res, 200, { ...this.settings, threadTargets: this.management.targets, sessionIds: this.sessions, states: Object.fromEntries(this.states) });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    if (this.active.size) return json(res, 409, { error: "Stop native work before changing its destination" });
    try {
      const next = this.validate(await readBody(req));
      if (next.bindings.some(binding => !this.store.bot(binding.botId))) throw refuse("Unknown native Bot");
      for (const binding of next.bindings) {
        const old = this.settings.bindings.find(item => item.botId === binding.botId);
        if (old && ["host", "user", "stateRoot", "profile"].some(key => old[key as keyof NativeOmpBinding] !== binding[key as keyof NativeOmpBinding])) throw refuse("Changing a native identity requires a separately reviewed migration");
      }
      for (const timer of this.reconnectTimers.values()) clearTimeout(timer); this.reconnectTimers.clear(); this.reconnectAttempts.clear();
      this.save(this.file, next); this.settings = next;
      for (const client of this.clients.values()) client.close(); this.clients.clear(); this.start();
      return json(res, 200, this.settings);
    } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Invalid native connection" }); }
  };
}

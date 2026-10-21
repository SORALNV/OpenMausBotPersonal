import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeOmpTransport, nativeOmpCommand, type OmpQuestion, type OmpDestination } from "../scripts/native-omp-transport.mjs";
import { NativeOmpCollab } from "../scripts/native-omp-collab.mjs";
import type { NativeOmpBinding } from "../shared/native-omp.ts";
import type { RequestOutcome } from "./contracts.ts";
import type { RelayTextGenerator } from "./codex-relay-mediator.ts";
import { presentDirectReply, type ReplyFormatter } from "./direct-thread-bridge.ts";
import type { Message, Store } from "./store.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { reviewNativeQuestion } from "./native-omp-review.ts";

type Binding = NativeOmpBinding & { threadId: string };
type Receipt = { digest: string; stage: "prepared" | "submitted" | "completed" | "not-sent" | "indeterminate"; sessionId?: string };
type Active = { controller: AbortController; source: Pick<Message, "id" | "text">; client?: NativeOmpTransport; questions: Set<string>; cards: Map<string, { nativeId: string; question: OmpQuestion; card: Message; allowValue?: string }>; stopped: boolean; onSettled?: () => void };
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

  constructor(input: { dir: string; store: Store; open?: (binding: OmpDestination) => NativeOmpTransport; generate: RelayTextGenerator; formatter: ReplyFormatter; settled: () => void }) {
    this.dir = input.dir; this.store = input.store; this.open = input.open ?? (binding => NativeOmpTransport.connect(binding, { timeoutMs: 90_000 }));
    this.generate = input.generate; this.formatter = input.formatter; this.settled = input.settled;
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
    for (const threadId of Object.keys(this.sessions)) {
      const bot = this.store.botByThread(threadId), binding = bot && this.binding(bot.id, threadId);
      if (binding?.connection === "shared-tui") void this.sharedClient(binding).initialize().catch(() => this.states.set(threadId, "disconnected"));
    }
  }

  private sharedClient(binding: Binding): NativeOmpTransport {
    const current = this.clients.get(binding.threadId);
    if (current && !(current as NativeOmpCollab).closed) return current;
    this.clients.delete(binding.threadId);
    const client = NativeOmpCollab.connect({ ...binding, expectedSessionId: this.sessions[binding.threadId] }, { timeoutMs: 90_000 });
    this.clients.set(binding.threadId, client);
    const approvals: Active = { controller: new AbortController(), source: { id: `native-host-${binding.threadId}`, text: "" }, client, questions: new Set(), cards: new Map(), stopped: false };
    this.sharedQuestions.set(binding.threadId, approvals);
    client.on("question", (question: OmpQuestion) => { void this.question(binding, approvals, question, this.active.get(binding.threadId)); });
    client.on("questionCancelled", (id: string) => {
      approvals.questions.delete(id);
      for (const [requestId, pending] of approvals.cards) if (pending.nativeId === id) this.expire(binding.threadId, approvals, requestId);
    });
    client.on("nativeEntry", (event: { entryId: string; role?: string; text: string; own: boolean; activeOwn: boolean; snapshot: boolean; sessionId: string }) => {
      if (!event.entryId || !["user", "assistant"].includes(event.role ?? "") || !event.text) return;
      const seen = this.observed[binding.threadId] ??= [];
      if (seen.includes(event.entryId)) return;
      if (seen.length >= 10_000) { client.close(); this.states.set(binding.threadId, "history-review-required"); return; }
      seen.push(event.entryId);
      const existing = this.store.messagesFor(binding.threadId);
      const oldEnvelope = event.text.match(/"request_id":"([\w-]+)"/u)?.[1];
      const isExisting = existing.some(m => m.nativeOmp?.entryId === event.entryId) || event.snapshot && (existing.some(m => m.role === (event.role === "user" ? "user" : "bot") && (m.text === event.text || m.nativeOmp?.originalText === event.text)) || Boolean(oldEnvelope && this.ledger[oldEnvelope]));
      if (!isExisting && !event.own && !(event.activeOwn && event.role === "assistant")) {
        this.store.appendMessage(binding.threadId, { role: event.role === "user" ? "user" : "bot", kind: "text", text: event.text,
          nativeOmp: { sessionId: event.sessionId, requestId: `native-entry-${event.entryId}`, entryId: event.entryId, originalText: event.text, source: "human" } });
      }
      this.save(this.observedFile, this.observed);
    });
    client.on("nativeState", ({ busy }: { busy: boolean }) => {
      this.nativeBusy.set(binding.threadId, busy);
      if (!this.active.has(binding.threadId)) {
        this.states.set(binding.threadId, busy ? "human-working" : "idle");
        this.store.setTaskActivity(binding.botId, binding.threadId, approvals.cards.size ? "waiting-on-you" : busy ? "working" : "idle");
        if (!busy) this.settled();
      }
    });
    client.on("disconnected", () => {
      approvals.stopped = true; approvals.controller.abort();
      for (const id of approvals.cards.keys()) this.expire(binding.threadId, approvals, id);
      if (this.sharedQuestions.get(binding.threadId) === approvals) this.sharedQuestions.delete(binding.threadId);
      this.nativeBusy.delete(binding.threadId);
      this.clients.delete(binding.threadId); this.states.set(binding.threadId, "disconnected");
      if (!this.active.has(binding.threadId)) this.store.setTaskActivity(binding.botId, binding.threadId, "idle");
    });
    return client;
  }

  binding(botId: string, threadId: string): Binding | undefined {
    const binding = this.settings.bindings.find(item => item.enabled && item.botId === botId);
    return binding && this.store.taskByThread(botId, threadId) ? { ...binding, threadId } : undefined;
  }

  dispatch(binding: Binding, text: string, fields: Pick<Message, "sendId" | "sender" | "via" | "callId"> = {}, existingSource?: Message, onSettled?: () => void): Message {
    if (!this.binding(binding.botId, binding.threadId) || this.active.has(binding.threadId)) throw refuse("Native OhMyPi session is unavailable or busy");
    if (this.store.taskByThread(binding.botId, binding.threadId)?.busy) throw refuse("Native OhMyPi session is busy");
    if (!text.trim() || text.length > 100_000 || /<attached-(?:image|file|audio)\b|\[.*?\]\((?:attachment:|\/?api\/attachments\/)|data:(?:image|audio)\//iu.test(text)) throw refuse("Native OhMyPi currently accepts plain text only");
    if (Object.keys(this.ledger).length >= 5000) throw refuse("Native request ledger needs owner review before further submissions");
    const source = existingSource ?? this.store.appendMessage(binding.threadId, { role: "user", kind: "text", text, ...fields, requestPending: true });
    if (existingSource) this.store.patchMessage(binding.threadId, source.id, { requestPending: true });
    const job: Active = { controller: new AbortController(), source, questions: new Set(), cards: new Map(), stopped: false, onSettled };
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
      const preparation = this.generate(binding.mediator.providerId, binding.mediator.modelId,
        "あなたはOpenMausBotとPi上のOhMyPiをつなぐ仲介者です。次のJSONはユーザーの原文です。原文を補助する整理メモだけを日本語1文で返してください。依頼を実行せず、原文にない操作・権限・成功を追加せず、ツールを使わないでください。\n" + JSON.stringify({ user_request: text }), signal);
      const note = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error("Native mediation stopped"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        preparation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
      signal.throwIfAborted();
      if (typeof note !== "string" || !note.trim() || note.length > 4000) throw refuse("Invalid mediator output");
      job.controller.signal.throwIfAborted();
      phase = "connect";
      const client = job.client = binding.connection === "shared-tui" ? this.sharedClient(binding) : this.open(binding);
      if (binding.connection !== "shared-tui") {
        client.on("question", (question: OmpQuestion) => { void this.question(binding, job, question); });
        client.on("questionCancelled", (id: string) => {
          job.questions.delete(id);
          for (const [requestId, pending] of job.cards) if (pending.nativeId === id) this.expire(binding.threadId, job, requestId);
        });
      }
      client.on("nativeTool", (event: { type: string; toolName?: string; isError?: boolean }) => {
        const name = typeof event.toolName === "string" ? event.toolName.slice(0, 100) : "tool";
        this.store.appendMessage(binding.threadId, { role: "bot", kind: "activity", text: `Pi / OhMyPi: ${name} ${event.type === "tool_execution_start" ? "実行中" : event.isError ? "失敗" : "完了"}` });
      });
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
        turnId: `omp-${key}`, turnSucceeded: true, turnTerminal: true, turnCompletedAt: Date.now(), nativeOmp: metadata });
      this.states.set(binding.threadId, "idle");
      void presentDirectReply(text, displayText, this.formatter, binding.formatter).then(presentation => {
        if (this.store.taskByThread(binding.botId, binding.threadId)) this.store.patchMessage(binding.threadId, reply.id,
          { text: result.sharedTurn && !presentation.text.startsWith("共有ターン") ? "共有ターンの応答です。標準TUIからの入力も含まれています。\n\n" + presentation.text : presentation.text, nativeOmp: { ...metadata, formatted: presentation.formatted, formatterFailure: presentation.failure } });
      }).catch(() => {});
    } catch {
      const queued = binding.connection === "shared-tui" && (job.client as NativeOmpCollab | undefined)?.requestStatus?.(key) === "queued";
      if (queued) submitted = false;
      if (ownsReceipt && (this.ledger[key]?.stage === "prepared" || this.ledger[key]?.stage === "submitted")) {
        this.ledger[key].stage = submitted ? "indeterminate" : "not-sent"; this.save(this.ledgerFile, this.ledger);
      }
      this.states.set(binding.threadId, job.stopped ? "stopped" : submitted ? "indeterminate" : `not-sent:${phase}`);
      this.store.appendMessage(binding.threadId, { role: "bot", kind: "text", text: submitted
        ? "Piへ依頼を送信しましたが、処理の完了を確認できませんでした。Pi側の承認待ち・実行状況を確認してください。重複実行を避けるため自動再送はしていません。停止要求を出した場合も、実機での停止確認が必要です。"
        : queued ? "Pi側の処理・承認待ちで、この入力はまだ送信していません。自動再送はしていません。"
        : "仲介処理またはPiのOhMyPiへの接続に失敗したため、依頼本文は送信していません。認証と接続設定を確認してください。",
      requestMessageId: key, turnId: `omp-${key}`, turnSucceeded: false, turnTerminal: true, turnCompletedAt: Date.now() });
    } finally {
      clearTimeout(timeout);
      job.controller.abort();
      if (binding.connection !== "shared-tui") job.client?.close();
      if (binding.connection !== "shared-tui") { job.client?.removeAllListeners("question"); job.client?.removeAllListeners("questionCancelled"); }
      job.client?.removeAllListeners("nativeTool");
      for (const id of job.cards.keys()) this.expire(binding.threadId, job, id);
      this.store.patchMessage(binding.threadId, key, { requestPending: false, ...(job.stopped ? { requestCancelled: true } : {}) });
      this.active.delete(binding.threadId);
      const activity = this.sharedQuestions.get(binding.threadId)?.cards.size ? "waiting-on-you" : this.nativeBusy.get(binding.threadId) ? "working" : "idle";
      if (activity !== "idle") this.states.set(binding.threadId, activity === "working" ? "human-working" : activity);
      this.store.setTaskActivity(binding.botId, binding.threadId, activity); job.onSettled?.(); this.settled();
    }
  }

  private async question(binding: Binding, job: Active, question: OmpQuestion, reviewJob?: Active): Promise<void> {
    const owns = () => this.active.get(binding.threadId) === job || this.sharedQuestions.get(binding.threadId) === job;
    if (!owns()) return;
    if (job.questions.has(question.id)) return;
    job.questions.add(question.id);
    const reviewer = reviewJob ?? (this.active.get(binding.threadId) === job ? job : undefined);
    const allowed = reviewer && !reviewer.stopped ? await reviewNativeQuestion(binding, reviewer.source.text ?? "", question, this.generate, AbortSignal.any([job.controller.signal, reviewer.controller.signal])) : false;
    if (!owns() || job.stopped || reviewer?.stopped || !job.questions.has(question.id)) return;
    if (allowed) {
      try {
        job.client!.answerUi(question.id, { value: "Approve" });
        job.questions.delete(question.id);
        this.store.appendMessage(binding.threadId, { role: "bot", kind: "activity", text: "Pi / OhMyPi: Lunaが低リスク操作を確認し、今回の操作を許可しました" });
        return;
      } catch { job.questions.delete(question.id); return; }
    }
    const id = `native-omp-${randomUUID()}`;
    // OhMyPi 18.12.5 emits native tool approvals as select dialogs; never expose its session-wide approval option.
    const allowValue = question.method === "select" && question.title?.startsWith("Allow tool:") && question.options?.includes("Approve") && question.options.includes("Deny") ? "Approve" : undefined;
    const permission = question.method === "confirm" || allowValue !== undefined;
    const card = this.store.appendMessage(binding.threadId, { role: "bot", kind: "options", card: {
      title: permission ? "Pi / OhMyPiの操作許可" : "Pi / OhMyPiからの確認",
      subtitle: [question.title, question.message].filter(Boolean).join("\n").slice(0, 16000),
      options: permission ? ["Allow", "Deny"] : question.options ?? [], requestId: id, requestType: permission ? "permission" : "question", tool: `OhMyPi/${question.method}`,
    } });
    job.cards.set(id, { nativeId: question.id, question, card, ...(allowValue ? { allowValue } : {}) });
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
    try { job.client!.answerUi(pending.nativeId, pending.allowValue ? { value: behavior === "allow" ? pending.allowValue : "Deny" } : permission ? { confirmed: behavior === "allow" } : { value: text! }); }
    catch { this.expire(threadId, job, requestId); return "unavailable"; }
    job.cards.delete(requestId);
    job.questions.delete(pending.nativeId);
    this.store.patchMessage(threadId, pending.card.id, { card: { ...pending.card.card!, answered: behavior, ...(text ? { answeredText: text } : {}) } });
    this.store.setTaskActivity(this.store.botByThread(threadId)!.id, threadId, job.cards.size ? "waiting-on-you" : "working");
    return permission ? behavior === "allow" ? "allowed-once" : "rejected" : "answered";
  }

  async stop(threadId: string): Promise<boolean> {
    const job = this.active.get(threadId); if (!job) return false;
    job.stopped = true; job.controller.abort();
    if (job.client) {
      try { await job.client.stop(); } finally { job.client.close(); }
    }
    return true;
  }

  close(): void {
    for (const id of this.active.keys()) void this.stop(id);
    for (const [threadId, job] of this.sharedQuestions) { job.stopped = true; job.controller.abort(); for (const id of job.cards.keys()) this.expire(threadId, job, id); }
    for (const client of this.clients.values()) client.close(); this.clients.clear(); this.sharedQuestions.clear();
  }

  route: RouteHandler = async ({ path, method, auth, json, req, res, readBody }) => {
    if (path !== "/api/native-omp") return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Owner scope required" });
    res.setHeader("Cache-Control", "no-store");
    if (method === "GET") return json(res, 200, { ...this.settings, states: Object.fromEntries(this.states) });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    if (this.active.size) return json(res, 409, { error: "Stop native work before changing its destination" });
    try {
      const next = this.validate(await readBody(req));
      if (next.bindings.some(binding => !this.store.bot(binding.botId))) throw refuse("Unknown native Bot");
      for (const binding of next.bindings) {
        const old = this.settings.bindings.find(item => item.botId === binding.botId);
        if (old && ["host", "user", "stateRoot", "profile"].some(key => old[key as keyof NativeOmpBinding] !== binding[key as keyof NativeOmpBinding])) throw refuse("Changing a native identity requires a separately reviewed migration");
      }
      this.save(this.file, next); this.settings = next;
      for (const client of this.clients.values()) client.close(); this.clients.clear(); this.start();
      return json(res, 200, this.settings);
    } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Invalid native connection" }); }
  };
}

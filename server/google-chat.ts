import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { McpServerSpec } from "./contracts.ts";
import type { RouteHandler } from "./routes/table.ts";
import { PASS } from "./routes/table.ts";
import { ChatDiagnostics, ChatFailure, chatDeadline, type ChatCode, type ChatStage } from "./google-chat-diagnostics.ts";
import { googleChatDirectNotice, googleChatSenderIsSelf, type GoogleChatCalendarAction, type GoogleChatClassification, type GoogleChatClassificationInput, type GoogleChatContextMessage, type GoogleChatNotificationAction } from "./google-chat-notification.ts";
import { GoogleChatReceipts } from "./google-chat-receipts.ts";

type Config = { enabled: boolean; url: string; token: string; botId: string; threadId: string; cursor: number };
type Incoming = { seq: number; kind: string; message: { id: string; text: string; previousText?: string; sender: { name: string }; space: { name: string }; thread?: { id?: string }; timestamp?: string; direction: string } };
interface Deps {
  target(botId: string, threadId: string): boolean;
  ownsThread(botId: string, threadId: string): boolean;
  mask(threadId: string, text: string, names: string[], signal?: AbortSignal): Promise<string>;
  maskResult?(threadId: string, value: unknown, signal: AbortSignal): Promise<unknown>;
  hasEvent(threadId: string, eventId: string): boolean;
  classify?(botId: string, threadId: string, input: GoogleChatClassificationInput, signal: AbortSignal): Promise<GoogleChatClassification>;
  enqueue?(botId: string, threadId: string, action: GoogleChatCalendarAction, eventId: string, timeZone: string, signal: AbortSignal): Promise<void>;
  report?(botId: string, threadId: string, text: string, eventId: string, signal: AbortSignal): Promise<void>;
  selfName?: () => string;
  timeZone?: () => string;
  attention(botId: string, threadId: string, status: string): void;
  enabled?: boolean;
  credentialsFile?: string;
  bridgeUrl?: string;
  timeoutMs?: number;
}

export class GoogleChatLink {
  private config?: Config;
  private readonly file: string;
  private abort?: AbortController;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private state = "disabled";
  private lastNotice = "";
  private healthySince?: number;
  private verificationEpoch?: number;
  private failures = 0;
  private readonly receipts?: GoogleChatReceipts;
  private readonly deps: Deps;
  readonly diagnostics: ChatDiagnostics;
  constructor(dir: string, deps: Deps) {
    this.deps = deps;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error("Private Google Chat storage must not be a symlink");
    chmodSync(dir, 0o700);
    try { this.receipts = new GoogleChatReceipts(dir); } catch { this.state = "STORAGE_FAILED"; }
    this.diagnostics = new ChatDiagnostics(dir);
    this.lastNotice = this.diagnostics.lastNotice;
    this.file = join(dir, "google-chat.json");
    if (existsSync(this.file)) {
      try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384) throw new Error("Invalid private Google Chat configuration");
      this.config = this.validate(JSON.parse(readFileSync(this.file, "utf8")));
      } catch { this.state = "configuration_error"; }
    }
  }
  private validate(value: unknown): Config {
    const c = value as Config;
    const url = new URL(c.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp" || !url.port || url.username || url.password || url.search || url.hash
      || typeof c.enabled !== "boolean" || typeof c.token !== "string" || !/^[\w-]{32,256}$/.test(c.token)
      || !/^[\w-]{1,100}$/.test(c.botId) || !/^[\w-]{1,100}$/.test(c.threadId) || !Number.isSafeInteger(c.cursor) || c.cursor < 0) throw new Error("Invalid Google Chat configuration");
    return { enabled: c.enabled, url: url.href, token: c.token, botId: c.botId, threadId: c.threadId, cursor: c.cursor };
  }
  private save(c: Config): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(c), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file);
    this.config = c;
  }
  status() {
    const c = this.config;
    this.verificationEpoch ??= Date.now();
    const ready = Boolean(c?.enabled && this.state === "OK");
    const diagnostics = this.diagnostics.snapshot();
    const previousBody = diagnostics.body?.code === "OK" && (!ready || Date.parse(diagnostics.body.endedAt ?? diagnostics.body.startedAt) < this.verificationEpoch) ? diagnostics.body : null;
    return { enabled: c?.enabled ?? false, registered: Boolean(c), monitorReady: ready, notificationMode: "ai-personal-action", botId: c?.botId, threadId: c?.threadId, cursor: c?.cursor ?? 0, state: this.state,
      diagnostics: { ...diagnostics, body: previousBody ? null : diagnostics.body, previousBody } };
  }
  protects(threadId: string): boolean { return Boolean(this.config?.enabled && this.deps.ownsThread(this.config.botId, threadId)); }
  server(botId: string, replies = false): McpServerSpec | undefined {
    const c = this.config;
    if (!c?.enabled || c.botId !== botId) return;
    return { type: "http", url: c.url, headers: { Authorization: `Bearer ${c.token}`, ...(!replies ? { "X-GChat-Read-Only": "true" } : {}) } };
  }
  private async feed(c: Config, after: number | undefined, signal: AbortSignal) {
    const url = new URL("/local/changes", c.url);
    if (after !== undefined) url.searchParams.set("after", String(after));
    let response: Response;
    try { response = await fetch(url, { redirect: "error", headers: { Authorization: `Bearer ${c.token}` }, signal }); }
    catch { throw new ChatFailure(signal.aborted ? "FEED_TIMEOUT" : "FEED_CONNECTION"); }
    if ([401, 403].includes(response.status)) throw new ChatFailure("FEED_AUTH");
    if (!response.ok) throw new ChatFailure("FEED_HTTP");
    if (Number(response.headers.get("content-length") ?? 0) > 5_000_000) throw new ChatFailure("FEED_INVALID");
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 5_000_000) { await reader.cancel(); throw new Error("Google Chat feed too large"); } chunks.push(value); }
    let result: { cursor: number; changes: Incoming[]; status: string };
    try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ChatFailure("FEED_INVALID"); }
    if (!Number.isSafeInteger(result.cursor) || result.cursor < 0 || !Array.isArray(result.changes) || result.changes.length > 100 || typeof result.status !== "string" || !/^[A-Z_]{1,64}$/.test(result.status)) throw new ChatFailure("FEED_INVALID");
    return result;
  }
  async configure(value: unknown): Promise<void> {
    if (!(this.deps.enabled ?? process.env.OMB_PERSONAL_BUILD === "1")) throw new Error("Personal build required");
    const c = this.validate({ ...(value as object), cursor: this.config?.cursor ?? 0 });
    if (!this.deps.target(c.botId, c.threadId)) throw new Error("Select an existing conversation owned by this bot");
    this.stop();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
    let monitorState = "disabled";
    try {
      if (c.enabled) {
        const probe = await chatDeadline(this.deps.timeoutMs ?? 5000, undefined, signal => this.feed(c, undefined, signal), "FEED_TIMEOUT");
        monitorState = probe.status;
        if (!this.config || c.url !== this.config.url || c.token !== this.config.token || c.botId !== this.config.botId || c.threadId !== this.config.threadId) c.cursor = probe.cursor;
      }
      if (c.enabled && monitorState === "OK") {
        const id = this.diagnostics.begin("warmup", "mask");
        try { await chatDeadline(this.deps.timeoutMs ?? 120000, undefined, signal => this.deps.mask(c.threadId, "", [], signal), "MASK_TIMEOUT"); this.diagnostics.end(id); }
        catch (error) { this.diagnostics.end(id, error instanceof ChatFailure ? error.code : "MASK_FAILED"); throw error; }
      }
      this.save(c);
      this.verificationEpoch = Date.now();
      this.state = monitorState;
      this.start();
    } catch (error) { this.start(); throw error; }
  }
  start(): void {
    if (!this.config?.enabled || !(this.deps.enabled ?? process.env.OMB_PERSONAL_BUILD === "1")) return;
    if (this.state === "disabled") this.state = "connecting";
    clearTimeout(this.timer);
    this.abort ??= new AbortController();
    this.timer = setTimeout(() => { void this.poll(); }, 0);
    this.timer.unref();
  }
  async poll(): Promise<void> {
    if (this.running || !this.config?.enabled || this.abort?.signal.aborted) return;
    this.running = true;
    const c = this.config; const abort = this.abort ??= new AbortController();
    const id = this.diagnostics.begin("poll", "feed");
    const progress: { stage: ChatStage } = { stage: "feed" };
    const at = (next: ChatStage) => { progress.stage = next; this.diagnostics.stage(id, next); };
    try {
      if (!this.deps.target(c.botId, c.threadId)) throw new ChatFailure("TARGET_MISSING");
      if (!this.receipts) throw new ChatFailure("STORAGE_FAILED");
      const result = await chatDeadline(this.deps.timeoutMs ?? 45000, abort.signal, signal => this.feed(c, c.cursor, signal), "FEED_TIMEOUT");
      at("parse");
      if (result.cursor < c.cursor) throw new ChatFailure("CURSOR_RESET");
      if (result.status !== "OK") {
        this.state = result.status; this.notice(result.status); this.diagnostics.end(id); return;
      }
      let previous = c.cursor;
      for (const item of result.changes) {
        if (!Number.isSafeInteger(item.seq) || item.seq <= previous || item.seq > result.cursor || !["created", "updated"].includes(item.kind)) throw new Error("Invalid Google Chat event");
        previous = item.seq;
        const m = item.message;
        if (!m || typeof m.text !== "string" || !m.text || m.text.length > 32000 || typeof m.sender?.name !== "string" || m.sender.name.length > 300 || typeof m.id !== "string" || typeof m.space?.name !== "string" || typeof m.thread?.id !== "string" || !["incoming", "outgoing"].includes(m.direction)
          || (m.timestamp !== undefined && (typeof m.timestamp !== "string" || m.timestamp.length > 100 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(m.timestamp) || !Number.isFinite(Date.parse(m.timestamp))))) throw new Error("Invalid Google Chat message");
        if (m.previousText !== undefined && (typeof m.previousText !== "string" || m.previousText.length > 32000)) throw new ChatFailure("FEED_INVALID");
        const receipt = this.receipts.identify([c.url, c.botId, c.threadId], m);
        const eventId = receipt.eventId;
        if (m.direction !== "outgoing" && !receipt.seen && !this.deps.hasEvent(c.threadId, eventId) && !this.deps.hasEvent(c.threadId, `${new URL(c.url).port}:${item.seq}`)) {
          at("mask");
          const sender = await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.mask(c.threadId, m.sender.name, [m.sender.name], signal), "MASK_TIMEOUT");
          const text = await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.mask(c.threadId, m.text, [m.sender.name], signal), "MASK_TIMEOUT");
          const previousText = m.previousText === undefined ? undefined : await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.mask(c.threadId, m.previousText!, [m.sender.name], signal), "MASK_TIMEOUT");
          if (abort.signal.aborted || this.config !== c || !this.deps.target(c.botId, c.threadId)) return;
          at("context");
          const context = await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.context(c, signal), "CONTEXT_TIMEOUT");
          if (abort.signal.aborted || this.config !== c || !this.deps.target(c.botId, c.threadId)) return;
          at("classify");
          if (!this.deps.classify) throw new ChatFailure("CLASSIFIER_FAILED");
          const timeZone = this.deps.timeZone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
          const profileName = this.deps.selfName?.().trim() ?? "";
          const userName = profileName
            ? await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.mask(c.threadId, profileName, [profileName], signal), "MASK_TIMEOUT")
            : "";
          const classification = await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.classify!(c.botId, c.threadId, {
            kind: item.kind as "created" | "updated", sender, senderIsSelf: googleChatSenderIsSelf(m.sender.name, this.deps.selfName?.() ?? ""), direction: m.direction,
            ...(m.timestamp ? { timestamp: m.timestamp } : {}), text, previousText, previousNotice: receipt.previousNotice, timeZone, userName, context,
          }, signal), "CLASSIFIER_TIMEOUT");
          if (abort.signal.aborted || this.config !== c || !this.deps.target(c.botId, c.threadId)) return;
          if (classification.kind !== "ignore") {
            at("queue");
            const action: GoogleChatNotificationAction = { ...classification, postedBy: sender || "Google Chat" };
            if (!this.deps.enqueue || action.kind === "general_notification" || action.kind === "my_shift_confirmation" || (action.kind === "other_shift_request" && !action.location)) {
              if (!this.deps.report) throw new ChatFailure("QUEUE_FAILED");
              await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.report!(c.botId, c.threadId, googleChatDirectNotice(action), eventId, signal), "QUEUE_FAILED");
            } else {
              if (!this.deps.enqueue) throw new ChatFailure("QUEUE_FAILED");
              await chatDeadline(this.deps.timeoutMs ?? 120000, abort.signal, signal => this.deps.enqueue!(c.botId, c.threadId, action as GoogleChatCalendarAction, eventId, timeZone, signal), "QUEUE_FAILED");
            }
          }
          at("persist");
          this.receipts.record(receipt.key, receipt.revision, classification.kind === "ignore" ? undefined : classification.kind === "general_notification" ? classification.summary : JSON.stringify(classification));
        }
        at("persist"); c.cursor = item.seq; this.save(c); at("parse");
      }
      at("persist"); c.cursor = result.cursor; this.save(c);
      this.state = result.status;
      this.failures = 0;
      this.diagnostics.end(id);
      this.notice(result.status);
    } catch (error) {
      const code: ChatCode = abort.signal.aborted ? "CANCELLED" : error instanceof ChatFailure ? error.code : progress.stage === "mask" ? "MASK_FAILED" : progress.stage === "context" ? "CONTEXT_FAILED" : progress.stage === "classify" ? "CLASSIFIER_FAILED" : progress.stage === "queue" ? "QUEUE_FAILED" : progress.stage === "deliver" ? "DELIVERY_FAILED" : progress.stage === "persist" ? "STORAGE_FAILED" : progress.stage === "parse" ? "FEED_INVALID" : "FEED_CONNECTION";
      this.diagnostics.end(id, code);
      if (!abort.signal.aborted) {
        this.state = code;
        ++this.failures; this.notice(code);
      }
    } finally {
      this.running = false;
      if (!abort.signal.aborted && this.config?.enabled) {
        this.timer = setTimeout(() => { void this.poll(); }, Math.min(60000, 250 * 2 ** Math.min(this.failures, 8)));
        this.timer.unref();
      }
    }
  }
  private notice(status: string): void {
    const c = this.config!;
    if (this.lastNotice === "LOGIN_REQUIRED" && ["COLLECTOR_STALE", "FEED_TIMEOUT", "FEED_CONNECTION", "BROWSER_OFFLINE"].includes(status)) return;
    if (status === "OK") {
      this.healthySince ??= Date.now();
      if (!this.lastNotice || this.lastNotice === "OK" || Date.now() - this.healthySince < 30000) return;
    } else this.healthySince = undefined;
    if (status === this.lastNotice) return;
    this.deps.attention(c.botId, c.threadId, status); this.lastNotice = status; this.diagnostics.notified(status);
  }
  private async verifyMonitor(c: Config): Promise<void> {
    this.verificationEpoch ??= Date.now();
    const result = await chatDeadline(this.deps.timeoutMs ?? 5000, undefined, signal => this.feed(c, undefined, signal), "FEED_TIMEOUT");
    this.state = result.status;
    if (result.status !== "OK") throw new ChatFailure("MONITOR_NOT_READY");
  }
  private async context(c: Config, signal: AbortSignal): Promise<GoogleChatContextMessage[]> {
    if (!this.deps.maskResult) throw new ChatFailure("CONTEXT_FAILED");
    let response: Response;
    try {
      response = await fetch(c.url, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", "MCP-Protocol-Version": "2026-07-28", "X-GChat-Read-Only": "true" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_monitored_thread", arguments: {} } }),
      });
    } catch { throw new ChatFailure(signal.aborted ? "CONTEXT_TIMEOUT" : "CONTEXT_FAILED"); }
    if (!response.ok) throw new ChatFailure("CONTEXT_FAILED");
    const text = await response.text();
    if (text.length > 2_000_000) throw new ChatFailure("CONTEXT_FAILED");
    let rpc: any;
    try { rpc = JSON.parse(text); } catch { throw new ChatFailure("CONTEXT_FAILED"); }
    const source = rpc?.result?.structuredContent?.result?.messages;
    if (rpc?.error || rpc?.result?.isError || !Array.isArray(source) || source.length > 2000) throw new ChatFailure("CONTEXT_FAILED");
    const selected: { text: string; sender: { name: string }; direction: string; timestamp?: string }[] = [];
    let characters = 0;
    for (const value of source.slice(-30).reverse()) {
      const body = value?.text, sender = value?.sender?.name ?? "";
      if (typeof body !== "string" || body.length > 32000 || typeof sender !== "string" || sender.length > 300) throw new ChatFailure("CONTEXT_FAILED");
      if (characters + body.length + sender.length > 24000) continue;
      characters += body.length + sender.length;
      selected.unshift({ text: body, sender: { name: sender }, direction: typeof value.direction === "string" ? value.direction : "unknown", ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp.slice(0, 100) } : {}) });
    }
    const filtered = await chatDeadline(this.deps.timeoutMs ?? 120000, signal, inner => this.deps.maskResult!(c.threadId, { structuredContent: { result: { messages: selected } } }, inner), "MASK_TIMEOUT");
    const messages = (filtered as any)?.structuredContent?.result?.messages;
    if (!Array.isArray(messages) || messages.length !== selected.length) throw new ChatFailure("CONTEXT_FAILED");
    return messages.map((value: any, index: number) => {
      const sender = value?.sender?.name;
      const body = value?.text;
      if (typeof body !== "string" || body.length > 32000 || (sender !== undefined && (typeof sender !== "string" || sender.length > 300))) throw new ChatFailure("CONTEXT_FAILED");
      const originalSender = selected[index]?.sender.name;
      return {
        sender: typeof sender === "string" ? sender : "",
        senderIsSelf: typeof originalSender === "string" && googleChatSenderIsSelf(originalSender, this.deps.selfName?.() ?? ""),
        direction: typeof value?.direction === "string" ? value.direction : "unknown",
        ...(typeof value?.timestamp === "string" ? { timestamp: value.timestamp.slice(0, 100) } : {}),
        text: body,
      };
    });
  }
  async check(): Promise<{ messages: number }> {
    const c = this.config;
    if (!c?.enabled || !this.deps.target(c.botId, c.threadId) || !this.deps.maskResult) throw new ChatFailure("TARGET_MISSING");
    const id = this.diagnostics.begin("body", "upstream");
    const progress = { stage: "upstream" };
    try {
      await this.verifyMonitor(c);
      const rpc = await chatDeadline(15000, undefined, async signal => {
        const response = await fetch(c.url, { method: "POST", redirect: "error", signal, headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", "MCP-Protocol-Version": "2026-07-28", "X-GChat-Read-Only": "true" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_monitored_thread", arguments: {} } }) });
        if (!response.ok) throw new ChatFailure("UPSTREAM_FAILED");
        const text = await response.text();
        if (text.length > 2_000_000) throw new ChatFailure("BODY_INVALID");
        this.diagnostics.stage(id, "parse"); progress.stage = "parse";
        return JSON.parse(text);
      }, "UPSTREAM_TIMEOUT");
      if (rpc.error || rpc.result?.isError || !Array.isArray(rpc.result?.structuredContent?.result?.messages)) throw new ChatFailure("BODY_INVALID");
      progress.stage = "mask"; this.diagnostics.stage(id, "mask");
      await chatDeadline(this.deps.timeoutMs ?? 120000, undefined, signal => this.deps.maskResult!(c.threadId, rpc.result, signal), "MASK_TIMEOUT");
      await this.verifyMonitor(c);
      this.diagnostics.end(id);
      return { messages: rpc.result.structuredContent.result.messages.length };
    } catch (error) {
      const code = error instanceof ChatFailure ? error.code : progress.stage === "mask" ? "MASK_FAILED" : progress.stage === "parse" ? "BODY_INVALID" : "UPSTREAM_FAILED";
      this.diagnostics.end(id, code); throw new ChatFailure(code);
    }
  }
  stop(): void { clearTimeout(this.timer); this.abort?.abort(); this.abort = undefined; }
  route: RouteHandler = async ({ req, res, path, method, auth, readBody, json }) => {
    if (!["/api/google-chat", "/api/google-chat/connect", "/api/google-chat/check"].includes(path)) return PASS;
    if (!["GET", "PUT", "POST"].includes(method)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin") || auth.kind !== "loopback") return json(res, 403, { error: "Mac上の所有者設定専用です。" });
    try {
      if (path.endsWith("/check")) {
        if (method !== "POST") return json(res, 405, { error: "POST required" });
        const check = await this.check();
        return json(res, 200, { ...this.status(), check });
      }
      if (path.endsWith("/connect") && method === "POST") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
        const body = await readBody(req, 16384);
        const file = this.deps.credentialsFile ?? join(homedir(), "Code", "GoogleChatExtensionMCP", ".local", "credentials.json");
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384) throw new Error("Private credentials required");
        const token = JSON.parse(readFileSync(file, "utf8")).mcpToken;
        await this.configure({ enabled: true, url: this.deps.bridgeUrl ?? "http://127.0.0.1:17321/mcp", token, botId: body.botId, threadId: body.threadId });
      } else if (method === "PUT") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
        const body = await readBody(req, 16384);
        await this.configure(body?.enabled === false && this.config ? { ...this.config, enabled: false } : body);
      }
      return json(res, 200, this.status());
    } catch (error) { return json(res, 400, { code: error instanceof ChatFailure ? error.code : "CONFIGURATION_FAILED", error: "Google Chatの接続・保存・本文診断に失敗しました。段階別の診断を確認してください。" }); }
  };
}

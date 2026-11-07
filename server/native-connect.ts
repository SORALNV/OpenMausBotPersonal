import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NativeAntigravityTransport, type NativeProgress, type NativeReply } from "../scripts/native-antigravity-transport.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

/** NativeConnect's destination is configured by the owner, independently of every Bot's conversation model. */
export interface NativeConnectSettings { enabled: boolean; model: string; binary: string }
type Receipt = { state: "submitted" | "completed" | "failed"; sessionId: string; error?: string };
type State = { sessions: Record<string, string>; receipts: Record<string, Receipt> };
const id = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,160}$/u.test(value);
const reject = (message: string) => Object.assign(new Error(message), { status: 409 });
const key = (...values: string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");

export const NATIVE_CONNECT_PROMPT = "NativeConnect is available through native_connect (find_tool can find it). You remain the conversational agent: keep your role, memory, context and normal OMB tools. Answer ordinary consultation and OMB management yourself. Delegate only work that actually needs the Antigravity harness or when the person requests that harness. Supply a self-contained natural-language task with necessary context and constraints, like a human entering a prompt. Do not forward the whole conversation, your system instructions, secrets, or permission grants. The destination executes its own tools and retains its own conversation. Read its result as external information, verify what it establishes and answer the person in your normal concise style. Do not claim a task succeeded merely because it was submitted. Use the same session for this OMB thread; do not create OMB threads for delegation. NativeConnect does not inherit Full access as a bypass of the CLI's native permissions. If a native operation is denied, report it rather than retrying or using another route. The run tool waits for the result and exposes progress; do not poll it concurrently.";

/** Owns delegation only: it never handles the user's main chat turn or changes a Bot's model. */
export class NativeConnect {
  private readonly directory: string;
  private readonly settingsFile: string;
  private readonly stateFile: string;
  private settings: NativeConnectSettings;
  private state: State;
  private readonly transport: NativeAntigravityTransport;
  private models: { id: string; name: string }[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly preparing = new Set<string>();

  constructor(directory: string, transport?: NativeAntigravityTransport) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== process.getuid?.()) throw reject("NativeConnectの保存先を確認できません。");
    this.directory = realpathSync(directory);
    if (lstatSync(this.directory).mode & 0o077) throw reject("NativeConnectの保存先は本人専用にしてください。");
    this.settingsFile = join(this.directory, "native-connect.json");
    this.stateFile = join(this.directory, "native-connect-state.json");
    this.settings = existsSync(this.settingsFile) ? this.read(this.settingsFile) : { enabled: false, model: "claude-sonnet-5-5-medium", binary: join(homedir(), ".gemini/bin/agy") };
    if (typeof this.settings.enabled !== "boolean" || !id(this.settings.model) || !isAbsolute(this.settings.binary)) throw reject("NativeConnectの設定が不正です。");
    this.state = existsSync(this.stateFile) ? this.read(this.stateFile) : { sessions: {}, receipts: {} };
    if (!this.state.sessions || !this.state.receipts || Object.entries(this.state.sessions).some(([k, value]) => !id(k) || !id(value)) ||
      Object.entries(this.state.receipts).some(([k, value]) => !id(k) || !value || !["submitted", "completed", "failed"].includes(value.state) || !id(value.sessionId))) throw reject("NativeConnectの会話対応が不正です。");
    this.transport = transport ?? new NativeAntigravityTransport({ command: this.settings.binary, directory: join(this.directory, "native-connect-sessions") });
  }

  private read(file: string, maxBytes = 8_000_000) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > maxBytes) throw reject("NativeConnectの非公開設定を確認できません。");
    return JSON.parse(readFileSync(file, "utf8"));
  }

  private save() { writeFileAtomic(this.stateFile, JSON.stringify(this.state), { mode: 0o600 }); }
  enabled() { return this.settings.enabled; }
  snapshot() { return { enabled: this.settings.enabled, model: this.settings.model, models: this.models, active: this.active.size }; }
  async refreshModels() { this.models = await this.transport.models(); return this.snapshot(); }

  async configure(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw reject("設定が不正です。");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(k => !["enabled", "model"].includes(k)) || typeof input.enabled !== "boolean" || !id(input.model)) throw reject("有効化と委託先モデルを指定してください。");
    if (this.active.size || this.preparing.size) throw reject("委託中の設定は変更できません。");
    if (input.enabled && (!(this.models.length) || !this.models.some(model => model.id === input.model))) await this.refreshModels();
    if (input.enabled && !this.models.some(model => model.id === input.model)) throw reject("CLIのモデル一覧から選択してください。");
    if (this.active.size || this.preparing.size) throw reject("委託中の設定は変更できません。");
    this.settings = { ...this.settings, enabled: input.enabled, model: input.model };
    writeFileAtomic(this.settingsFile, JSON.stringify(this.settings), { mode: 0o600 });
    return this.snapshot();
  }

  async status(botId: string, threadId: string) {
    const sessionId = this.state.sessions[key(botId, threadId)];
    if (!sessionId) return { connected: false, busy: false, model: this.settings.model };
    const state = await this.transport.read(sessionId);
    return { connected: true, sessionId, nativeConversationId: state.nativeId, busy: this.active.has(key(botId, threadId)), pending: state.pending, model: state.model };
  }

  async run(input: { botId: string; threadId: string; requestId: string; cwd: string; prompt: string; signal: AbortSignal; requireActive: () => void; progress: (event: NativeProgress) => void }) {
    if (!this.enabled()) throw reject("NativeConnectは無効です。");
    if (!id(input.botId) || !id(input.threadId) || !id(input.requestId) || !isAbsolute(input.cwd) || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 100_000) throw reject("委託先または依頼文が不正です。");
    const source = key(input.botId, input.threadId);
    const receiptKey = key(source, input.requestId, input.prompt);
    input.signal.throwIfAborted(); input.requireActive();
    const old = this.state.receipts[receiptKey];
    if (old?.state === "completed") return { ...this.read(join(this.directory, "native-connect-results", `${receiptKey}.json`), 2_000_000) as NativeReply, reusedReceipt: true };
    if (old) throw reject("同じ依頼は送信済みです。重複実行を防ぐため再送していません。");
    if (this.active.has(source) || this.preparing.has(source)) throw reject("この会話では既に委託中です。再送していません。");
    if (Object.keys(this.state.receipts).length >= 5000) throw reject("委託記録の上限に達しました。管理者による整理が必要です。");
    this.preparing.add(source);
    const controller = new AbortController();
    this.active.set(source, controller);
    try {
      input.signal.throwIfAborted(); input.requireActive();
      let sessionId = this.state.sessions[source];
      if (!sessionId) {
        const session = await this.transport.create({ cwd: input.cwd, model: this.settings.model });
        this.state.sessions[source] = session.id; sessionId = session.id; this.save();
      }
      const session = await this.transport.read(sessionId);
      if (session.cwd !== input.cwd) throw reject("会話の作業フォルダーが変わっています。既存の接続先を確認してください。");
      if (session.model !== this.settings.model) await this.transport.select(sessionId, this.settings.model);
      input.signal.throwIfAborted(); input.requireActive();
      this.state.receipts[receiptKey] = { state: "submitted", sessionId }; this.save();
      this.preparing.delete(source);
      try {
        const result = await this.transport.prompt(sessionId, input.prompt, { signal: AbortSignal.any([controller.signal, input.signal]), progress: input.progress });
        const results = join(this.directory, "native-connect-results");
        mkdirSync(results, { recursive: true, mode: 0o700 });
        if (lstatSync(results).isSymbolicLink() || lstatSync(results).mode & 0o077) throw reject("委託結果の保存先を確認できません。");
        writeFileAtomic(join(results, `${receiptKey}.json`), JSON.stringify(result), { mode: 0o600 });
        this.state.receipts[receiptKey] = { state: "completed", sessionId }; this.save();
        input.requireActive();
        return { ...result, reusedReceipt: false };
      } catch (error) {
        if (this.state.receipts[receiptKey]?.state !== "completed") {
          this.state.receipts[receiptKey] = { state: "failed", sessionId, error: "完了を確認できませんでした。依頼は自動再送していません。" }; this.save();
        }
        throw error;
      }
    } finally { this.preparing.delete(source); this.active.delete(source); }
  }

  stop(botId: string, threadId: string) { this.active.get(key(botId, threadId))?.abort(); }
  close() { for (const controller of this.active.values()) controller.abort(); }

  route: RouteHandler = async ({ path, method, auth, req, res, json, readBody }) => {
    if (path !== "/api/native-connect" && path !== "/api/native-connect/models") return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Owner scope required" });
    res.setHeader("Cache-Control", "no-store");
    try {
      if (method === "GET" && path === "/api/native-connect") return json(res, 200, this.snapshot());
      if (method === "POST" && path === "/api/native-connect/models") return json(res, 200, await this.refreshModels());
      if (method === "PUT" && path === "/api/native-connect") return json(res, 200, await this.configure(await readBody(req)));
      return json(res, 405, { error: "method not allowed" });
    } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "NativeConnectを確認できません。" }); }
  };
}

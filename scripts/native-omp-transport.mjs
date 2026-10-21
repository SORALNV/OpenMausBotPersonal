import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";

const FRAME_LIMIT = 1_048_576;
const MESSAGE_LIMIT = 64 * 1_048_576;

function remotePath(value) {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_./-]+$/u.test(value) || value.split("/").includes("..")) throw new Error("Invalid remote path");
  return value;
}

export function nativeOmpCommand(binding) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(binding.host ?? "") || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(binding.user ?? "")) throw new Error("Invalid SSH destination");
  if (![binding.botId, binding.threadId].every(value => typeof value === "string" && value.trim() && value.length <= 200)) throw new Error("Explicit bot and thread required");
  const key = createHash("sha256").update(JSON.stringify([binding.botId, binding.threadId])).digest("hex");
  const sessionDir = `${remotePath(binding.stateRoot).replace(/\/$/u, "")}/${key}`;
  const binary = remotePath(binding.binary);
  const profile = binding.profile ?? "omb-native";
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(profile)) throw new Error("Invalid native profile");
  const workspace = binding.cwd === undefined ? [] : ["--cwd", `'${remotePath(binding.cwd)}'`];
  const model = binding.model === undefined ? [] : ["--model", `'${binding.model}'`];
  if (binding.model !== undefined && !/^[\w./:-]{1,160}$/u.test(binding.model)) throw new Error("Invalid native model");
  const options = ["--profile", `'${profile}'`, ...workspace, ...model, "--no-lsp", "--no-pty", "--no-extensions", "--no-skills", "--no-rules", "--tools", "read,bash,edit,write,grep,glob,ask", "--approval-mode", "always-ask"];
  return {
    command: "/usr/bin/ssh",
    args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "--", `${binding.user}@${binding.host}`,
      `exec '${binary}' --mode rpc-ui ${options.join(" ")} --session-dir '${sessionDir}' --continue`],
    sessionDir,
  };
}

function waitSlot(timeoutMs, label) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A startup/command rejection can precede the caller attaching its await.
  void promise.catch(() => {});
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  return { promise, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
}

/** Native OMP JSONL over a pinned SSH destination. No shell/file tools are delegated to the Mac. */
export class NativeOmpTransport extends EventEmitter {
  constructor(child, sessionDir, { timeoutMs = 30_000, turnTimeoutMs = 600_000 } = {}) {
    super();
    this.child = child;
    this.sessionDir = remotePath(sessionDir);
    this.timeoutMs = timeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map();
    this.receipts = new Map();
    this.ui = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = waitSlot(timeoutMs, "OhMyPi startup");
    this.chunk = null;
    this.turn = null;
    this.failure = null;
    child.stdout.on("data", data => this.read(data));
    // Remote stderr may contain credentials or user content. Never forward it to normal logs.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.fail(new Error("OhMyPi input closed; do not resend automatically")));
    child.on("error", () => this.fail(new Error("SSH could not start")));
    child.on("close", code => this.fail(new Error(`SSH closed (${code ?? "signal"}); do not resend automatically`)));
    void this.ready.promise.catch(error => this.fail(error));
  }

  static connect(binding, options) {
    const plan = nativeOmpCommand(binding);
    const env = Object.fromEntries(["HOME", "PATH", "SSH_AUTH_SOCK", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    return new NativeOmpTransport(spawn(plan.command, plan.args, { stdio: ["pipe", "pipe", "pipe"], env, shell: false }), plan.sessionDir, options);
  }

  send(frame) {
    if (this.failure) throw this.failure;
    const data = Buffer.from(JSON.stringify(frame) + "\n");
    if (data.length > FRAME_LIMIT) throw new Error("OhMyPi input exceeds transport limit");
    this.child.stdin.write(data);
  }

  async command(type, args = {}) {
    const id = randomUUID(), pending = waitSlot(this.timeoutMs, `OhMyPi ${type}`);
    this.pending.set(id, pending);
    try {
      this.send({ ...args, id, type });
      const response = await pending.promise;
      if (response.command !== type || response.success !== true) throw new Error(`OhMyPi refused ${type}`);
      return response.data;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally { this.pending.delete(id); }
  }

  async initialize() {
    const ready = await this.ready.promise;
    if (!ready.supportedProtocolVersions?.includes(2)) {
      const error = new Error("OhMyPi RPC v2 required");
      this.fail(error);
      throw error;
    }
    await this.command("negotiate_protocol", { protocolVersion: 2 });
    const session = await this.command("open_session", { sessionDir: this.sessionDir });
    if (session?.cancelled || typeof session?.sessionFile !== "string" || !session.sessionFile.startsWith(this.sessionDir + "/") || session.sessionFile.split("/").includes("..")) {
      const error = new Error("OhMyPi did not open the pinned session");
      this.fail(error);
      throw error;
    }
    this.session = session;
    return session;
  }

  async submit(requestId, text) {
    if (!this.session) throw new Error("Initialize the pinned session first");
    if (this.failure) throw this.failure;
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200 || typeof text !== "string" || !text.trim() || text.length > 100_000) throw new Error("Invalid native request");
    const digest = createHash("sha256").update(text).digest("hex");
    const previous = this.receipts.get(requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Error("Request ID reused with different text");
      return previous.promise;
    }
    if (this.turn) throw new Error("OhMyPi session is busy");
    const pending = waitSlot(this.turnTimeoutMs, "OhMyPi turn");
    const promise = pending.promise.catch(error => { this.fail(error); throw error; });
    void promise.catch(() => {});
    this.turn = { id: requestId, pending, texts: [], result: null, settled: false, messages: new Set() };
    this.receipts.set(requestId, { digest, promise });
    try { this.send({ id: requestId, type: "prompt", message: text }); }
    catch (error) { this.fail(error); }
    return promise;
  }

  /** Caller must route this only from an authenticated human approval/question response, never an agent tool. */
  answerUi(id, answer) {
    const request = this.ui.get(id);
    if (!request) throw new Error("No pending native question");
    let response;
    if (answer?.cancelled === true) response = { cancelled: true };
    else if (request.method === "confirm" && typeof answer?.confirmed === "boolean") response = { confirmed: answer.confirmed };
    else if (["input", "editor", "select"].includes(request.method) && typeof answer?.value === "string" && answer.value.length <= 100_000 &&
      (request.method !== "select" || request.options?.includes(answer.value))) response = { value: answer.value };
    else throw new Error("Unsupported or invalid native question answer");
    this.send({ type: "extension_ui_response", id, ...response });
    this.ui.delete(id);
  }

  async stop() {
    const turn = this.turn;
    if (!turn || this.failure) return false;
    this.send({ type: "abort", id: randomUUID() });
    let timer;
    try {
      return await Promise.race([
        turn.pending.promise.then(() => false, () => turn.aborted === true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  close() {
    if (this.failure) return;
    if (this.turn || this.pending.size || !this.session) { this.fail(new Error("Native connection closed")); return; }
    this.failure = new Error("Native connection closed");
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 5000);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.ready.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turn?.pending.reject(error);
    this.turn = null;
    this.ui.clear();
    this.buffer = Buffer.alloc(0);
    this.chunk = null;
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    this.emit("disconnected", error.message);
  }

  read(data) {
    if (this.failure) return;
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      let end;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        if (end + 1 > FRAME_LIMIT) throw new Error("Oversized OhMyPi frame");
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        if (line.length) this.decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        if (this.failure) return;
      }
      if (this.buffer.length >= FRAME_LIMIT) throw new Error("Oversized OhMyPi frame");
    } catch { this.fail(new Error("Invalid OhMyPi transport frame; do not resend automatically")); }
  }

  decode(frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid frame");
    if (frame.type !== "rpc_chunk") {
      if (this.chunk) throw new Error("Interrupted OhMyPi chunks");
      return this.frame(frame);
    }
    const { index, count, byteLength, chunkId, data } = frame;
    if (!Number.isInteger(count) || count < 2 || count > 256 || !Number.isInteger(index) || index < 0 || index >= count ||
      !Number.isInteger(byteLength) || byteLength < 1 || byteLength > MESSAGE_LIMIT || typeof chunkId !== "string" || !chunkId ||
      typeof data !== "string" || data.length > 349_528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) throw new Error("Invalid chunk");
    this.chunk ??= { chunkId, count, byteLength, parts: [], bytes: 0 };
    const chunk = this.chunk;
    const part = Buffer.from(data, "base64");
    if (!part.length || part.length > 262_144 || part.toString("base64") !== data || chunk.chunkId !== chunkId || chunk.count !== count || chunk.byteLength !== byteLength || index !== chunk.parts.length || chunk.bytes + part.length > byteLength) throw new Error("Invalid chunk sequence");
    chunk.parts.push(part); chunk.bytes += part.length;
    if (chunk.parts.length !== count) return;
    if (chunk.bytes !== byteLength) throw new Error("Incomplete chunks");
    this.chunk = null;
    this.frame(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunk.parts))));
  }

  frame(frame) {
    if (frame.type === "ready") { this.ready.resolve(frame); return; }
    if (frame.type === "rpc_frame_error") throw new Error("OhMyPi output exceeded transport limit");
    if (frame.type === "response") {
      if (frame.id === this.turn?.id && frame.success === false) this.fail(new Error("Native prompt refused or failed; do not resend automatically"));
      this.pending.get(frame.id)?.resolve(frame);
      return;
    }
    if (frame.type === "extension_ui_request") {
      if (frame.method === "cancel") { this.ui.delete(frame.targetId); this.emit("questionCancelled", frame.targetId); return; }
      if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"].includes(frame.method)) return;
      if (!this.listenerCount("question") || !["confirm", "select", "input", "editor"].includes(frame.method) || typeof frame.id !== "string") {
        this.fail(new Error("Native question needs a supported human approval interface"));
        return;
      }
      this.ui.set(frame.id, frame);
      this.emit("question", frame);
      return;
    }
    if (["host_tool_call", "host_uri_request"].includes(frame.type)) throw new Error("Mac host tools are unavailable to remote OhMyPi");
    if (["tool_execution_start", "tool_execution_end"].includes(frame.type)) this.emit("nativeTool", { type: frame.type, toolName: frame.toolName, toolCallId: frame.toolCallId, isError: frame.isError });
    const turn = this.turn;
    if (!turn) return;
    if (frame.type === "message_end" && frame.message?.role === "assistant") {
      const text = (frame.message.content ?? []).filter(item => item.type === "text").map(item => item.text).join("");
      if (text && !turn.messages.has(frame.messageId ?? text)) { turn.texts.push(text); turn.messages.add(frame.messageId ?? text); }
    }
    if (frame.type === "prompt_result" && frame.id === turn.id) {
      if (frame.status === "aborted") turn.aborted = true;
      if (frame.status !== "completed") { this.fail(new Error(`Native prompt ${frame.status}; do not resend automatically`)); return; }
      turn.result = frame;
      if (frame.sessionSettled === true) turn.settled = true;
    }
    if (frame.type === "session_settled") turn.settled = true;
    if (turn.result && turn.settled) {
      if (!turn.texts.length) { this.fail(new Error("Native turn returned no assistant text")); return; }
      this.turn = null;
      turn.pending.resolve({ requestId: turn.id, sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, text: turn.texts.join("\n\n") });
    }
  }
}

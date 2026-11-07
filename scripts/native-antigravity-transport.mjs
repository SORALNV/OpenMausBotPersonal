import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const identifier = value => typeof value === "string" && /^[\w.-]{1,160}$/u.test(value);
const fail = message => Object.assign(new Error(message), { code: -32602 });
const MAX_LINE = 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** Parses the public `agy models` table; no model is invented when discovery fails. */
export function antigravityCliModels(text) {
  const models = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([a-z][a-z0-9]*(?:-[a-z0-9.]+)+)\s+(.+)$/u);
    if (match && !models.some(model => model.id === match[1])) models.push({ id: match[1], name: match[2] });
  }
  if (!models.length || models.length > 128) throw fail("Antigravity CLIが有効なモデル一覧を返しませんでした。");
  return models;
}

/** Adapts only public CLI input/output. Credentials and native history remain owned by `agy`. */
export class NativeAntigravityTransport {
  constructor({ command, args = [], directory, env = process.env, timeoutMs = 300_000 }) {
    if (!isAbsolute(command) || !isAbsolute(directory)) throw fail("CLIと接続状態の保存先には絶対パスが必要です。");
    this.command = command;
    this.args = args;
    this.directory = directory;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.active = new Map();
  }

  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory() || info.mode & 0o077 ||
        info.uid !== process.getuid?.() || await realpath(this.directory) !== this.directory) {
      throw fail("接続状態の保存先は本人専用の実ディレクトリにしてください。");
    }
  }

  path(id) {
    if (!identifier(id)) throw fail("無効な接続IDです。");
    return join(this.directory, `${id}.json`);
  }

  async read(id) {
    await this.prepare();
    const file = await open(this.path(id), "r");
    try {
      const info = await file.stat();
      const link = await lstat(this.path(id));
      if (!info.isFile() || link.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077 ||
          info.uid !== process.getuid?.() || info.size > 8192) throw fail("接続状態の安全性を確認できません。");
      const state = JSON.parse(await file.readFile("utf8"));
      if (state.id !== id || !isAbsolute(state.cwd) || !identifier(state.model) ||
          state.nativeId !== undefined && !identifier(state.nativeId) || typeof state.pending !== "boolean") {
        throw fail("接続状態が不正です。");
      }
      return state;
    } catch {
      throw fail("接続状態を読み込めません。別の会話は作成していません。");
    } finally { await file.close(); }
  }

  async save(state) {
    const path = this.path(state.id);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  }

  async lock(id) {
    this.path(id);
    await this.prepare();
    const path = join(this.directory, `${id}.lock`);
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch { throw fail("この会話は別の接続で処理中です。再送はしていません。"); }
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    return async () => { await file.close(); await rm(path); };
  }

  async create({ cwd, model }) {
    if (!isAbsolute(cwd) || !identifier(model)) throw fail("作業先またはモデルが不正です。");
    await this.prepare();
    const state = { id: randomUUID(), cwd, model, pending: false };
    await this.save(state);
    return state;
  }

  async select(id, model) {
    if (!identifier(model)) throw fail("無効なモデルIDです。");
    const unlock = await this.lock(id);
    try {
      const state = await this.read(id);
      if (state.pending) throw fail("直前の処理結果が未確認のためモデルを変更できません。");
      state.model = model;
      await this.save(state);
      return state;
    } finally { await unlock(); }
  }

  async models() {
    const text = await new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.args, "models"], { env: this.env, stdio: ["ignore", "pipe", "ignore"] });
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(fail("モデル一覧の取得がタイムアウトしました。")); }, 20_000);
      child.on("error", () => reject(fail("Antigravity CLIを起動できません。")));
      child.stdout.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_LINE) { child.kill("SIGKILL"); reject(fail("モデル一覧が上限を超えました。")); }
        else chunks.push(chunk);
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(fail("Antigravity CLIのモデル一覧を取得できません。ログインを確認してください。"));
      });
    });
    return antigravityCliModels(text);
  }

  async prompt(id, text, { signal, progress = () => {} } = {}) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_LINE / 2) throw fail("入力は空でない512KB以内のテキストにしてください。");
    const unlock = await this.lock(id);
    try {
      const state = await this.read(id);
      if (state.pending) throw fail("直前の依頼の完了が未確認です。重複実行を防ぐため再送しません。");
      if (signal?.aborted) throw fail("送信前に中止されました。");
      state.pending = true;
      state.requestHash = createHash("sha256").update(text).digest("hex");
      await this.save(state);
      const args = [...this.args, "--input-format", "stream-json", "--output-format", "stream-json", "--model", state.model,
        ...(state.nativeId ? ["--conversation", state.nativeId] : [])];
      let output;
      try { output = await this.run(id, args, state, text, signal, progress); }
      catch (error) { if (error.notStarted) { state.pending = false; await this.save(state); } throw error; }
      state.pending = false;
      state.lastStatus = output.status;
      await this.save(state);
      if (output.status !== "SUCCESS") {
        throw fail(`Antigravity CLIは${output.status}で終了しました。自動再送はしていません。`);
      }
      return { nativeId: state.nativeId, text: output.response, model: state.model, permissionNotice: output.permissionNotice };
    } finally { await unlock(); }
  }

  async run(id, args, state, text, signal, progress) {
    let persistence = Promise.resolve();
    let result;
    let failure;
    let buffer = "";
    let size = 0;
    let permissionNotice = false;
    const decoder = new StringDecoder("utf8");
    const child = spawn(this.command, args, { cwd: state.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.active.set(id, child);
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
    };
    let force;
    const abort = () => {
      failure ??= fail("CLIへの停止を要求しました。既に開始した操作の停止は別途確認が必要です。");
      stop();
      force ??= setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 2000);
    };
    const acceptId = nativeId => {
      if (!identifier(nativeId) || state.nativeId && state.nativeId !== nativeId) throw fail("CLIの会話IDが接続先と一致しません。");
      if (!state.nativeId) { state.nativeId = nativeId; persistence = persistence.then(() => this.save(state)); }
    };
    const receive = line => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > MAX_LINE) throw fail("CLIの出力行が上限を超えました。");
      const event = JSON.parse(line);
      if (result) throw fail("CLIが終了結果の後に追加の出力を返しました。");
      if (event.event === "init") {
        acceptId(event.conversation_id);
        if (event.init?.model && event.init.model !== state.model) throw fail("CLIが異なるモデルで起動しました。");
      } else if (event.event === "step_update") {
        const step = event.step_update;
        acceptId(step?.conversation_id);
        if (step.step_type === "tool" && ["ACTIVE", "DONE"].includes(step.state)) {
          progress({ type: "tool", id: String(step.step_index), name: String(step.tool_name ?? "tool").slice(0, 100),
            state: step.state === "DONE" ? step.tool_info?.error ? "failed" : "completed" : "in_progress" });
        } else if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          progress({ type: "text", text: step.text_delta });
        }
      } else if (event.event === "result") {
        const value = event.result;
        acceptId(value?.conversation_id);
        if (!["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"].includes(value.status) || typeof value.response !== "string") throw fail("CLIの終了結果が不正です。");
        result = value;
      }
    };
    const timer = setTimeout(() => { failure = fail("CLIの応答がタイムアウトしました。再送はしていません。"); abort(); }, this.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await new Promise((resolve, reject) => {
        child.on("error", () => { failure = Object.assign(fail("Antigravity CLIを起動できません。"), { notStarted: true }); });
        child.stdin.on("error", () => { failure ??= fail("CLIへの送信を確認できません。再送はしていません。"); stop(); });
        child.stdout.on("data", chunk => {
          try {
            size += chunk.length;
            if (size > MAX_OUTPUT) throw fail("CLIの出力が上限を超えました。");
            buffer += decoder.write(chunk);
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); receive(line);
            }
            if (Buffer.byteLength(buffer) > MAX_LINE) throw fail("CLIの出力行が上限を超えました。");
          } catch { failure ??= fail("CLIの出力を検証できません。再送はしていません。"); abort(); }
        });
        child.stderr.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_OUTPUT) { failure ??= fail("CLIの診断出力が上限を超えました。"); abort(); }
          if (/denied|permission|approval/iu.test(chunk.toString("utf8"))) permissionNotice = true;
        });
        child.on("close", code => {
          try {
            buffer += decoder.end();
            if (buffer.trim()) receive(buffer);
            if (failure) throw failure;
            if (code !== 0 || !result) throw fail("CLIの正常終了を確認できません。再送はしていません。");
            resolve();
          } catch (error) { reject(error); }
        });
        child.stdin.end(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
        if (signal?.aborted) abort();
      });
    } finally {
      clearTimeout(timer); clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      this.active.delete(id);
      await persistence;
    }
    return { ...result, permissionNotice };
  }

}

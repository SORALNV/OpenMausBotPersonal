import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { PrivacyBlocked } from "./policy.ts";
import type { PrivacySpan } from "./rules.ts";

export interface Detector { detect(texts: string[], signal?: AbortSignal): Promise<PrivacySpan[][]>; close(): void }

export class LocalDetector implements Detector {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending?: { resolve(value: unknown): void; reject(error: Error): void };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeout: number;
  private readonly command?: { file: string; args: string[] };

  constructor(timeoutMs = 120_000, command?: { file: string; args: string[] }) { this.timeout = timeoutMs; this.command = command; }

  private next(signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.close();
        finish(new PrivacyBlocked("ローカル検出が中断・タイムアウトしました。送信していません。"));
      };
      const timer = setTimeout(stop, this.timeout);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        this.pending = undefined;
        if (error) reject(error); else resolve(value);
      };
      this.pending = { resolve: value => finish(undefined, value), reject: error => finish(error) };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    });
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (this.ready) return this.ready;
    const python = process.env.OMB_PRIVACY_PYTHON;
    const checkpoint = process.env.OMB_PRIVACY_CHECKPOINT;
    const worker = process.env.OMB_PRIVACY_WORKER;
    if (!python || !checkpoint || !worker) throw new PrivacyBlocked("ローカル検出モデルの設定がありません。privacy:dev で起動してください。");
    const first = this.next(signal);
    const child = spawn(this.command?.file ?? python, this.command?.args ?? ["-u", worker], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        OMB_PRIVACY_CHECKPOINT: checkpoint, TIKTOKEN_CACHE_DIR: process.env.TIKTOKEN_CACHE_DIR,
        OMB_PRIVACY_DEVICE: process.env.OMB_PRIVACY_DEVICE ?? "auto",
        HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TRANSFORMERS_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.resume();
    child.stdin.on("error", () => this.fail());
    child.on("error", () => this.fail());
    child.on("exit", () => { if (this.child === child) this.fail(); });
    const lines = createInterface({ input: child.stdout });
    let bytes = 0;
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) this.fail(); });
    lines.on("line", line => {
      bytes = 0;
      try {
        const data = JSON.parse(line);
        if (data.error || !this.pending) return this.fail();
        this.pending.resolve(data);
      } catch { this.fail(); }
    });
    this.ready = first.then(value => {
      if (!(value as { ready?: boolean })?.ready) throw new PrivacyBlocked();
    });
    return this.ready;
  }

  private fail(): void {
    const pending = this.pending;
    this.close();
    pending?.reject(new PrivacyBlocked("ローカル検出プロセスが停止しました。送信していません。"));
  }

  detect(texts: string[], signal?: AbortSignal): Promise<PrivacySpan[][]> {
    const task = this.queue.then(async () => {
      signal?.throwIfAborted();
      await this.start(signal);
      if (!this.child || this.child.killed) throw new PrivacyBlocked();
      const response = this.next(signal);
      if (!signal?.aborted) this.child!.stdin.write(JSON.stringify({ texts }) + "\n");
      const value = await response as { spans?: PrivacySpan[][] };
      if (!Array.isArray(value.spans)) throw new PrivacyBlocked();
      return value.spans;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  close(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
    this.ready = undefined;
  }
}

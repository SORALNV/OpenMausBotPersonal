import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const CHAT_STAGES = ["feed", "parse", "upstream", "mask", "deliver", "persist"] as const;
export const CHAT_CODES = ["OK", "FEED_TIMEOUT", "FEED_CONNECTION", "FEED_AUTH", "FEED_HTTP", "FEED_INVALID", "BODY_INVALID", "CURSOR_RESET", "TARGET_MISSING", "MASK_TIMEOUT", "MASK_FAILED", "DELIVERY_FAILED", "STORAGE_FAILED", "UPSTREAM_TIMEOUT", "UPSTREAM_FAILED", "CANCELLED", "INTERRUPTED"] as const;
export type ChatStage = typeof CHAT_STAGES[number];
export type ChatCode = typeof CHAT_CODES[number];
type Operation = "poll" | "body" | "warmup";
type Step = { stage: ChatStage; startedAt: string; endedAt?: string };
type Job = { id: string; operation: Operation; stage: ChatStage; startedAt: string; stageStartedAt: string; steps: Step[]; endedAt?: string; elapsedMs?: number; code?: ChatCode };
export class ChatFailure extends Error {
  readonly code: ChatCode;
  constructor(code: ChatCode) { super(code); this.code = code; }
}

export class ChatDiagnostics {
  private readonly file: string;
  private jobs = new Map<string, Job>();
  private recent: Job[] = [];
  private latestBody?: Job;
  private latestWarmup?: Job;
  lastNotice = "";
  constructor(dir: string) {
    this.file = join(dir, "google-chat-diagnostics.json");
    if (existsSync(this.file)) {
      try {
        const stat = lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 262144) return;
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        if (typeof saved.lastNotice === "string" && /^[A-Z_]{1,64}$/.test(saved.lastNotice)) this.lastNotice = saved.lastNotice;
        for (const item of [...(saved.recent ?? []), saved.latestBody, saved.latestWarmup].filter(Boolean)) {
          if (!["poll", "body", "warmup"].includes(item.operation) || !CHAT_STAGES.includes(item.stage) || !/^[a-f0-9-]{36}$/.test(item.id) || !Number.isFinite(Date.parse(item.startedAt))) continue;
          const job: Job = { id: item.id, operation: item.operation, stage: item.stage, startedAt: item.startedAt, stageStartedAt: new Date(item.stageStartedAt).toISOString(), steps: (item.steps ?? []).slice(-12).filter((step: Step) => CHAT_STAGES.includes(step.stage) && Number.isFinite(Date.parse(step.startedAt))).map((step: Step) => ({ stage: step.stage, startedAt: new Date(step.startedAt).toISOString(), ...(Number.isFinite(Date.parse(step.endedAt ?? "")) ? { endedAt: new Date(step.endedAt!).toISOString() } : {}) })), endedAt: item.endedAt ? new Date(item.endedAt).toISOString() : new Date().toISOString(), code: CHAT_CODES.includes(item.code) ? item.code : "INTERRUPTED" };
          this.recent.push(job);
          if (job.operation === "body") this.latestBody = job;
          if (job.operation === "warmup") this.latestWarmup = job;
        }
        this.recent = this.recent.slice(-64);
      } catch { this.recent = []; }
    }
  }
  begin(operation: Operation, stage: ChatStage, id = randomUUID()): string {
    const now = new Date().toISOString();
    const job: Job = { id, operation, stage, startedAt: now, stageStartedAt: now, steps: [{ stage, startedAt: now }] };
    if (operation === "body") this.latestBody = job;
    if (operation === "warmup") this.latestWarmup = job;
    this.jobs.set(id, job); this.recent.push(job); this.recent = this.recent.slice(-64); this.save();
    return id;
  }
  stage(id: string, stage: ChatStage): void {
    const job = this.jobs.get(id); if (!job) return;
    const now = new Date().toISOString(); if (job.steps.at(-1)) job.steps.at(-1)!.endedAt = now;
    job.stage = stage; job.stageStartedAt = now; job.steps.push({ stage, startedAt: now }); job.steps = job.steps.slice(-12); this.save();
  }
  end(id: string, code: ChatCode = "OK"): void {
    const job = this.jobs.get(id); if (!job) return;
    job.endedAt = new Date().toISOString(); job.elapsedMs = Date.now() - Date.parse(job.startedAt); job.code = code;
    if (job.steps.at(-1)) job.steps.at(-1)!.endedAt = job.endedAt;
    this.jobs.delete(id); this.save();
  }
  snapshot() {
    const latest = (operation: Operation) => this.recent.findLast(job => job.operation === operation) ?? null;
    return { poll: latest("poll"), body: this.latestBody ?? null, warmup: this.latestWarmup ?? null, recent: this.recent.map(job => ({ ...job })) };
  }
  notified(status: string): void { if (/^[A-Z_]{1,64}$/.test(status)) { this.lastNotice = status; this.save(); } }
  private save(): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ lastNotice: this.lastNotice, latestBody: this.latestBody, latestWarmup: this.latestWarmup, recent: this.recent }), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file); chmodSync(this.file, 0o600);
  }
}

export async function chatDeadline<T>(ms: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, code: ChatCode): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); }), new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new ChatFailure(parent?.aborted ? "CANCELLED" : code));
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => controller.abort(), ms);
      if (signal.aborted) cancel();
    })]);
  } finally { clearTimeout(timer); if (cancel) signal.removeEventListener("abort", cancel); }
}

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "./store.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

export const BOT_THREAD_SWEEP_MS = 10 * 60_000;
export interface BotThreadCleanupPolicy { enabled: boolean; idleHours: number }
const DEFAULT_POLICY: BotThreadCleanupPolicy = { enabled: true, idleHours: 24 };
type Candidate = { createdAt: number; updatedAt?: number; lastThreadOrderAt?: number; askedAt?: number; background?: boolean; routineRunId?: string;
  openedBy?: { botId: string; at: number }; closedBy?: { at: number }; archivedAt?: number; pinned?: boolean; busy?: boolean; activity?: string };

export function idleBotThread(task: Candidate, now: number, idleMs: number): boolean {
  if ((!task.openedBy?.botId && !task.routineRunId && task.background !== true) || task.background === false || task.archivedAt !== undefined || task.pinned || task.busy || task.activity && task.activity !== "idle" && task.activity !== "dead") return false;
  const stamps = [task.createdAt, task.lastThreadOrderAt ?? task.updatedAt ?? task.createdAt, task.askedAt ?? 0, task.closedBy?.at ?? 0, task.openedBy?.at ?? 0];
  if (!Number.isFinite(now) || !Number.isFinite(idleMs) || idleMs <= 0 || stamps.some(stamp => !Number.isFinite(stamp))) return false;
  return now - Math.max(...stamps) > idleMs;
}

export function archiveIdleBotThreads(store: Store, policy: BotThreadCleanupPolicy, guard: (botId: string, threadId: string, idleMs: number) => boolean, now = Date.now()): number {
  if (!policy.enabled) return 0;
  const idleMs = policy.idleHours * 3_600_000;
  let count = 0;
  for (const bot of store.bots) for (const task of bot.tasks ?? []) {
    if (count >= 100) return count;
    if (!idleBotThread(task, now, idleMs) || guard(bot.id, task.threadId, idleMs)) continue;
    // Archive records and clear obsolete notifications; transcripts, provider cursors and remote sessions stay intact.
    if (!store.patchTask(bot.id, task.threadId, { archivedAt: now, unread: false })) continue;
    if (bot.threadId === task.threadId) {
      const fallback = bot.tasks?.find(candidate => candidate.archivedAt === undefined && !candidate.openedBy && !candidate.routineRunId);
      if (fallback) store.switchTask(bot.id, fallback.threadId);
    }
    count++;
  }
  return count;
}

export class BotThreadCleanup {
  private policy: BotThreadCleanupPolicy = { ...DEFAULT_POLICY };
  private file: string;
  private run?: () => number;
  constructor(file: string, run?: () => number) {
    this.file = file; this.run = run;
    if (!existsSync(file)) return;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 4096) throw Error("Invalid private cleanup settings");
    this.policy = this.validate(JSON.parse(readFileSync(file, "utf8")));
  }
  private validate(value: any): BotThreadCleanupPolicy {
    if (!value || typeof value.enabled !== "boolean" || !Number.isInteger(value.idleHours) || value.idleHours < 1 || value.idleHours > 720 || Object.keys(value).some(key => !["enabled", "idleHours"].includes(key))) throw Error("未使用期間は1〜720時間で指定してください。");
    return { enabled: value.enabled, idleHours: value.idleHours };
  }
  sweep(store: Store, guard: Parameters<typeof archiveIdleBotThreads>[2], now = Date.now()): number { return archiveIdleBotThreads(store, this.policy, guard, now); }
  route: RouteHandler = async ({ path, method, auth, json, res, req, readBody }) => {
    if (!["/api/bot-thread-cleanup", "/api/bot-thread-cleanup/run"].includes(path)) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Owner scope required" });
    res.setHeader("Cache-Control", "no-store");
    if (path.endsWith("/run")) return method === "POST" ? json(res, 200, { archived: this.run?.() ?? 0 }) : json(res, 405, { error: "Method not allowed" });
    if (method === "GET") return json(res, 200, this.policy);
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    try {
      const next = this.validate(await readBody(req));
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const parent = lstatSync(dirname(this.file));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || parent.mode & 0o077) throw Error("Private cleanup directory is unavailable");
      const temp = this.file + "." + randomUUID() + ".tmp";
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" }); renameSync(temp, this.file); this.policy = next;
      return json(res, 200, this.policy);
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "設定を保存できません。" }); }
  };
}

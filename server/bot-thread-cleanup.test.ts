import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveIdleBotThreads, BotThreadCleanup, idleBotThread } from "./bot-thread-cleanup.ts";
import { Store } from "./store.ts";
import { DATA_DIR } from "./config.ts";
import type { RouteContext } from "./routes/table.ts";
const HOUR = 3_600_000, now = Date.UTC(2026, 9, 28, 10), old = now - 48 * HOUR;
const candidate = { createdAt: old, updatedAt: old, openedBy: { botId: "synthetic-opener", at: old } };
const dirs: string[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it("expires only automatic threads, respects the boundary, and ignores housekeeping after meaningful activity", () => {
  expect(idleBotThread(candidate, now, 24 * HOUR)).toBe(true);
  expect(idleBotThread({ createdAt: old }, now, 24 * HOUR)).toBe(false);
  expect(idleBotThread({ createdAt: old, routineRunId: "synthetic-run" }, now, 24 * HOUR)).toBe(true);
  expect(idleBotThread({ createdAt: old, background: true }, now, 24 * HOUR)).toBe(true);
  expect(idleBotThread(candidate, old + 24 * HOUR, 24 * HOUR)).toBe(false);
  expect(idleBotThread({ ...candidate, updatedAt: now, lastThreadOrderAt: old }, now, 24 * HOUR)).toBe(true);
  expect(idleBotThread({ ...candidate, lastThreadOrderAt: now }, now, 24 * HOUR)).toBe(false);
  expect(idleBotThread({ ...candidate, closedBy: { at: now } }, now, 24 * HOUR)).toBe(false);
});

it.each([{ pinned: true }, { busy: true }, { activity: "waiting-on-you" }, { activity: "working" }, { activity: "parked.computer" }, { archivedAt: old }, { background: false }, { createdAt: NaN }, { createdAt: now + HOUR }])("protects explicit retention and unsafe state %j", patch => {
  expect(idleBotThread({ ...candidate, ...patch }, now, 24 * HOUR)).toBe(false);
});

it("archives once, clears obsolete notifications, retains every transcript and switches to the human main thread", () => {
  vi.spyOn(Date, "now").mockReturnValue(old);
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot({ name: "Synthetic" }); const main = bot.threadId;
  const stale = store.createTask(bot.id, "Synthetic bot work", true, undefined, { botId: bot.id, name: bot.name, at: old })!;
  const protectedTask = store.createTask(bot.id, "Synthetic protected", false, undefined, { botId: bot.id, name: bot.name, at: old })!;
  store.appendMessage(stale.threadId, { role: "bot", kind: "text", text: "架空の保存対象の履歴" }); store.patchTask(bot.id, stale.threadId, { unread: true });
  const before = JSON.stringify(store.messagesFor(stale.threadId));
  const guard = (_botId: string, id: string) => id === protectedTask.threadId;
  expect(archiveIdleBotThreads(store, { enabled: true, idleHours: 24 }, guard, now)).toBe(1);
  expect(stale.archivedAt).toBe(now); expect(stale.unread).toBe(false); expect(bot.threadId).toBe(main);
  expect(store.taskByThread(bot.id, main)?.archivedAt).toBeUndefined(); expect(protectedTask.archivedAt).toBeUndefined();
  expect(JSON.stringify(store.messagesFor(stale.threadId))).toBe(before);
  expect(archiveIdleBotThreads(store, { enabled: true, idleHours: 24 }, guard, now + HOUR)).toBe(0);
});

it("keeps all threads when disabled", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  expect(archiveIdleBotThreads(store, { enabled: false, idleHours: 24 }, () => { throw Error("disabled guard ran"); }, now)).toBe(0);
});

it("owner-only policy changes persist without restarting and invalid settings cannot replace them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-thread-cleanup-")); dirs.push(dir); const file = join(dir, "cleanup.json"); const cleanup = new BotThreadCleanup(file);
  const call = async (method: string, scopes: string[], body?: unknown) => {
    let result: { status: number; data: any } | undefined;
    await cleanup.route({ path: "/api/bot-thread-cleanup", method, auth: { scopes }, res: { setHeader() {} }, req: {}, readBody: async () => body,
      json: (_res: unknown, status: number, data: unknown) => { result = { status, data }; } } as unknown as RouteContext);
    return result!;
  };
  expect((await call("PUT", [], { enabled: false, idleHours: 3 })).status).toBe(403);
  expect((await call("PUT", ["admin"], { enabled: false, idleHours: 3 })).status).toBe(200);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ enabled: false, idleHours: 3 });
  expect((await call("PUT", ["admin"], { enabled: true, idleHours: 0 })).status).toBe(400);
  const restarted = new BotThreadCleanup(file); let restored: unknown;
  await restarted.route({ path: "/api/bot-thread-cleanup", method: "GET", auth: { scopes: ["admin"] }, res: { setHeader() {} }, json: (_res: unknown, _status: unknown, data: unknown) => { restored = data; } } as unknown as RouteContext);
  expect(restored).toEqual({ enabled: false, idleHours: 3 });
});

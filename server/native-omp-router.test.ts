import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeOmpSessions } from "./native-omp-sessions.ts";
import { Store } from "./store.ts";
import { DATA_DIR } from "./config.ts";
import type { NativeOmpSessionInfo } from "../shared/native-omp.ts";
const dirs: string[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-native-router-")); dirs.push(dir);
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot({ name: "Synthetic router" });
  const binding = { botId: bot.id, threadId: bot.threadId, enabled: true, host: "192.168.1.2", user: "fixture", binary: "/fixture/dsh", stateRoot: "/fixture/state", profile: "web", cwd: "/fixture/work", model: "fixture/model", mediator: { providerId: "fixture", modelId: "small", timeoutMs: 1000 } };
  const sessions: NativeOmpSessionInfo[] = []; let next = 0;
  const catalog = vi.fn(async (_binding: unknown, action: unknown, args: { name?: string } | undefined) => {
    if (action === "list") return { sessions: [...sessions] };
    const session = { id: "session-" + next++, name: args!.name!, directory: "/fixture/state", running: true, shared: true }; sessions.push(session); return { session };
  });
  const generate = vi.fn(async () => JSON.stringify({ action: "chat", name: "大学サイト", note: "実機作業" })); const apply = vi.fn(async () => {}), release = vi.fn();
  const input = { dir, store, read: (file: string) => JSON.parse(readFileSync(file, "utf8")), save: (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data), { mode: 0o600 }), generate, catalog, apply, release };
  return { dir, store, binding, sessions, generate, catalog, apply, release, manager: new NativeOmpSessions(input), restart: () => new NativeOmpSessions(input) };
}

it("free management is unpinned, reuses a purpose across requests and restart, and creates no OMB thread", async () => {
  const f = fixture(); f.manager.enableRouter(f.binding); expect(f.apply).not.toHaveBeenCalled(); expect(f.catalog).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  const prepared = await f.manager.prepare(f.binding, "架空の実行依頼", signal);
  const one = await f.manager.forRequest(f.binding, prepared.plan, signal);
  const two = await f.manager.forRequest(f.binding, prepared.plan, signal);
  expect(two.expectedSessionId).toBe(one.expectedSessionId); expect(f.sessions).toHaveLength(1);
  expect(f.manager.targets[f.binding.threadId]).toBeUndefined(); expect(f.manager.destination(f.binding).expectedSessionId).toBeUndefined();
  const restarted = f.restart(); const three = await restarted.forRequest(f.binding, prepared.plan, signal);
  expect(three.expectedSessionId).toBe(one.expectedSessionId); expect(f.store.bot(f.binding.botId)!.tasks).toHaveLength(1);
});

it("free management selects independent existing sessions and bounds automatic creation to eight", async () => {
  const f = fixture(); f.manager.enableRouter(f.binding); const signal = new AbortController().signal;
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push((await f.manager.forRequest(f.binding, { action: "chat", name: "用途" + i }, signal)).expectedSessionId!);
  await expect(f.manager.forRequest(f.binding, { action: "chat", name: "別用途9" }, signal)).rejects.toThrow("8件");
  expect(f.sessions).toHaveLength(8);
  expect((await f.manager.forRequest(f.binding, { action: "chat", sessionQuery: ids[0] }, signal)).expectedSessionId).toBe(ids[0]);
  expect((await f.manager.forRequest(f.binding, { action: "chat", sessionQuery: ids[3] }, signal)).expectedSessionId).toBe(ids[3]);
  expect(f.manager.targets[f.binding.threadId]).toBeUndefined();
});

it("fixed mode refuses model-invented session changes, while advice in router mode does not contact the harness", async () => {
  const f = fixture(), signal = new AbortController().signal;
  await expect(f.manager.prepare(f.binding, "架空", signal)).rejects.toThrow("振り分け");
  f.manager.enableRouter(f.binding); f.generate.mockResolvedValue(JSON.stringify({ action: "reply", answer: "相談だけの回答" }));
  expect((await f.manager.prepare(f.binding, "相談だけ", signal)).plan.action).toBe("reply");
  expect(f.catalog).not.toHaveBeenCalled(); expect(f.sessions).toHaveLength(0);
});

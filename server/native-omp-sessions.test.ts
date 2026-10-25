import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeOmpSessions } from "./native-omp-sessions.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import type { NativeOmpSessionInfo } from "../shared/native-omp.ts";

const dirs: string[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-omp-sessions-")); dirs.push(dir);
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Synthetic Pi" });
  const session: NativeOmpSessionInfo = { id: "native-project", name: "架空の研究", directory: "/fixture/native/project", file: "/fixture/native/project/synthetic.jsonl", running: false, shared: false };
  const catalog = vi.fn(async (_binding: unknown, action?: string) => action === "create" ? { session } : { sessions: [session] });
  const generate = vi.fn(async () => JSON.stringify({ action: "chat", note: "架空の整理メモ" }));
  const apply = vi.fn(async () => {});
  const binding = { botId: bot.id, threadId: bot.threadId, enabled: true, host: "fixture.test", user: "fixture", binary: "/fixture/omp", profile: "fixture", cwd: "/fixture/workspace", stateRoot: "/fixture/native", model: "fixture/model", mediator: { providerId: "fixture", modelId: "small", timeoutMs: 1000 } };
  const create = () => new NativeOmpSessions({ dir, store, catalog, generate, apply, read: file => JSON.parse(readFileSync(file, "utf8")), save: (file, value) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }) });
  return { dir, store, bot, session, catalog, generate, apply, binding, create, management: create() };
}

it("ordinary chat uses the existing session and never creates a thread or session", async () => {
  const f = fixture();
  const prepared = await f.management.prepare(f.binding, "ディスクの状態を調べて", new AbortController().signal);
  expect(prepared.plan.action).toBe("chat"); expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(1);
  expect(f.catalog).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
});

it("a project creation alone saves the session without changing the current connection or making a thread", async () => {
  const f = fixture();
  const result = await f.management.execute(f.binding, "create-only", { action: "create", name: "架空の研究", destination: "none" }, new AbortController().signal);
  expect(result).toContain("作成・保存"); expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(1);
  expect(f.apply).not.toHaveBeenCalled(); expect(f.management.targets).toEqual({});
});

it("creates and connects one new OMB thread, preserving the original conversation and deduplicating a receipt after restart", async () => {
  const f = fixture();
  const originalThreadId = f.binding.threadId;
  f.store.appendMessage(originalThreadId, { role: "user", kind: "text", text: "元の会話" });
  const plan = { action: "create" as const, name: "架空の研究", destination: "new-thread" as const };
  const first = await f.management.execute(f.binding, "one-request", plan, new AbortController().signal);
  const again = await f.create().execute(f.binding, "one-request", plan, new AbortController().signal);
  expect(again).toBe(first); expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(2);
  expect(f.catalog.mock.calls.filter(call => call[1] === "create")).toHaveLength(1); expect(f.apply).toHaveBeenCalledOnce();
  expect(f.store.messagesFor(originalThreadId).some(message => message.text === "元の会話")).toBe(true);
  const newThread = f.store.bot(f.bot.id)!.tasks!.find(task => task.threadId !== originalThreadId)!;
  expect(f.management.targets[newThread.threadId]).toMatchObject({ kind: "session", session: { id: f.session.id } });
});

it("an interrupted connection resumes the same created session and Thread instead of creating another", async () => {
  const f = fixture();
  f.apply.mockRejectedValueOnce(new Error("synthetic connection failed"));
  const plan = { action: "create" as const, name: "架空の研究", destination: "new-thread" as const };
  await expect(f.management.execute(f.binding, "interrupted", plan, new AbortController().signal)).rejects.toThrow("synthetic");
  await f.create().execute(f.binding, "interrupted", plan, new AbortController().signal);
  expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(2);
  expect(f.catalog.mock.calls.filter(call => call[1] === "create")).toHaveLength(1);
});

it("the existing-session UI request also reuses the same new Thread after a failed connection", async () => {
  const f = fixture();
  f.apply.mockRejectedValueOnce(new Error("synthetic unavailable"));
  await expect(f.management.connect(f.binding, f.session.id, "session", "新しい研究会話", "connect-request")).rejects.toThrow();
  await f.management.connect(f.binding, f.session.id, "session", "新しい研究会話", "connect-request");
  expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(2);
});

it("management mode uses a dedicated session target while individual histories remain separate", async () => {
  const f = fixture();
  const before = structuredClone(f.store.messagesFor(f.bot.threadId));
  await f.management.connect(f.binding, f.session.id, "manager");
  expect(f.management.targets[f.bot.threadId]!.kind).toBe("manager");
  expect(f.management.destination(f.binding)).toMatchObject({ sessionDir: f.session.directory, sessionFile: f.session.file, expectedSessionId: f.session.id });
  expect(f.store.messagesFor(f.bot.threadId)).toEqual(before);
});

it("ambiguous session names do not change a connection or create another Thread", async () => {
  const f = fixture();
  f.catalog.mockResolvedValue({ sessions: [f.session, { ...f.session, id: "second", directory: "/fixture/native/second", file: "/fixture/native/second/synthetic.jsonl" }] });
  await expect(f.management.execute(f.binding, "ambiguous", { action: "connect", sessionQuery: f.session.name, destination: "new-thread" }, new AbortController().signal)).rejects.toThrow("一つに特定");
  expect(f.apply).not.toHaveBeenCalled(); expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(1);
});

it("model-generated commands, foreign OMB Threads and undeclared new Thread requests are refused", async () => {
  const f = fixture();
  for (const plan of [{ action: "connect", command: "ssh bad" }, { action: "connect", threadId: "another-bot-thread" }, { action: "create", name: "架空", destination: "new-thread" }]) {
    f.generate.mockResolvedValue(JSON.stringify(plan));
    await expect(f.management.prepare(f.binding, "セッションを選んで", new AbortController().signal)).rejects.toThrow();
  }
  expect(f.apply).not.toHaveBeenCalled(); expect(f.catalog).not.toHaveBeenCalled();
});

it("different phrasings are interpreted through a validated plan, and malformed management plans never fall through to native chat", async () => {
  const f = fixture();
  for (const request of ["研究用セッションを追加して、新規スレッドから使わせて", "新しいThreadsに研究用のOMPセッションを割り当てて", "研究プロジェクトを独立したセッションとスレッドで始めたい"]) {
    f.generate.mockResolvedValue(JSON.stringify({ action: "create", name: "研究", destination: "new-thread", newThreadRequest: request }));
    expect((await f.management.prepare(f.binding, request, new AbortController().signal)).plan.action).toBe("create");
  }
  f.generate.mockResolvedValue("不正な非JSON回答");
  await expect(f.management.prepare(f.binding, "新しいセッションを作って", new AbortController().signal)).rejects.toThrow("OMP側には送信していません");
});

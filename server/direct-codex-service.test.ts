import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { DirectCodexService } from "./direct-codex-service.ts";
import type { NativeAsk, NativeClient } from "./direct-codex-client.ts";
import type { RouteContext } from "./routes/table.ts";

const dirs: string[] = [], services: DirectCodexService[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture(shared = false) {
  const dir = mkdtempSync(join(tmpdir(), "omb-direct-native-")); dirs.push(dir);
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Synthetic M1" });
  const binding = { botId: bot.id, threadId: bot.threadId, codexThreadId: "native-one", hostId: "local", enabled: true, formatter: { providerId: "fixture", modelId: "luna-fixture", timeoutMs: 1000 } };
  const clients: NativeClient[] = []; const calls: any[] = [];
  const eventListeners: Set<(method: string, params: any) => void>[] = [];
  let asks: ((ask: NativeAsk) => void) | undefined;
  let complete: (() => void) | undefined;
  let hold = false, conflict = false;
  let history: any[] = [{ id: "old", status: "completed", items: [] }];
  const open = vi.fn(async () => {
    const listeners = new Set<(method: string, params: any) => void>();
    eventListeners.push(listeners);
    const client: NativeClient = { shared, request: vi.fn(async (method, params: any) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: params.threadId } };
      if (method === "thread/turns/list") return { data: history.slice().reverse().slice(0, params.limit) };
      if (method === "thread/resume") { if (conflict) throw Error("already has an active writer"); return { thread: { id: params.threadId, status: { type: "idle" } } }; }
      if (method === "turn/start") {
        complete = () => { for (const fn of listeners) fn("turn/completed", { threadId: params.threadId, turn: { id: "turn-new", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "詳細な元回答", phase: "final_answer" }] } }); };
        if (!hold) complete(); return { turn: { id: "turn-new" } };
      }
      return {};
    }), onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }, onAsk: fn => { asks = fn; }, close: vi.fn(async () => {}) };
    clients.push(client); return client;
  });
  const format = vi.fn(async () => "短い回答"), settled = vi.fn();
  const prepare = vi.fn(async () => "依頼を整理する。");
  const service = new DirectCodexService(dir, store, open, { format }, settled, prepare); services.push(service);
  const route = async (method: string, value: unknown, admin = true) => {
    let status = 0, body: any;
    await service.route({ req: { headers: { "content-type": "application/json" } }, res: { setHeader() {} }, path: "/api/direct-codex", method,
      auth: { kind: "loopback", scopes: admin ? ["admin", "client"] : ["client"] }, readBody: async () => value,
      json: (_res: unknown, code: number, result: any) => { status = code; body = result; } } as unknown as RouteContext);
    return { status, body };
  };
  return { dir, store, bot, binding, service, clients, calls, format, prepare, settled, route,
    emit: (method: string, params: any) => { for (const listeners of eventListeners) for (const listener of listeners) listener(method, params); },
    hold: () => { hold = true; }, complete: () => complete?.(), conflict: (value = true) => { conflict = value; }, ask: (value: NativeAsk) => asks?.(value), history: (value: any[]) => { history = value; } };
}
it("persists owner-only per-thread bindings and refuses destination changes and paired-client configuration", async () => {
  const f = fixture();
  expect((await f.route("PUT", { bindings: [f.binding] }, false)).status).toBe(403);
  expect((await f.route("PUT", { bindings: [f.binding] })).status).toBe(200);
  expect(statSync(join(f.dir, "direct-codex.json")).mode & 0o777).toBe(0o600);
  expect((await f.route("PUT", { bindings: [{ ...f.binding, codexThreadId: "wrong" }] })).status).toBe(409);
  expect(f.service.binding(f.bot.id, "other")).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.dir, "direct-codex.json"), "utf8")).bindings[0].codexThreadId).toBe("native-one");
});
it("keeps app-origin approvals available in M1 and expires them when another subscriber resolves them", async () => {
  const f = fixture(true); await f.route("PUT", { bindings: [f.binding] }); f.service.startPolling();
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "thread/resume")).toBe(true));
  f.emit("turn/started", { threadId: "native-one", turn: { id: "app-turn" } });
  const userItem = { id: "app-user", type: "userMessage", content: [{ type: "text", text: "アプリの依頼" }] };
  f.emit("item/completed", { threadId: "native-one", turnId: "app-turn", item: userItem });
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.text === "アプリの依頼")).toBe(true);
  const answer = vi.fn();
  f.ask({ id: "app-approval", nativeRequestId: 42, method: "item/commandExecution/requestApproval", params: { threadId: "native-one", turnId: "app-turn", command: "synthetic command" }, answer });
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.card?.requestId === "app-approval")).toHaveLength(1);
  expect(answer).not.toHaveBeenCalled();
  f.emit("serverRequest/resolved", { threadId: "native-one", requestId: 42 });
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestId === "app-approval")?.card?.expired).toBe(true);
  expect(f.service.answer(f.bot.threadId, "app-approval", "allow")).toBeUndefined();
  expect(answer).not.toHaveBeenCalled();
  f.history([{ id: "old", status: "completed", items: [] }, { id: "app-turn", status: "completed", items: [userItem, { id: "app-answer", type: "agentMessage", text: "アプリの回答" }] }]);
  f.emit("turn/completed", { threadId: "native-one", turn: { id: "app-turn", status: "completed" } });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.nativeCodex?.originalText === "アプリの回答")).toBe(true));
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.text === "アプリの依頼")).toHaveLength(1);
});
it("accepts an explicit M1 response to an app-origin approval without a running M1 request", async () => {
  const f = fixture(true); await f.route("PUT", { bindings: [f.binding] }); f.service.startPolling();
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "thread/resume")).toBe(true));
  const answer = vi.fn();
  f.ask({ id: "passive-approval", nativeRequestId: 7, method: "item/fileChange/requestApproval", params: { threadId: "native-one", turnId: "app-turn" }, answer });
  expect(f.service.answer(f.bot.threadId, "passive-approval", "allow")).toBe("allowed-once");
  expect(answer).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  expect(f.service.answer(f.bot.threadId, "passive-approval", "allow")).toBeUndefined();
});
it("leaves a shared app-host tool to the desktop subscriber instead of stopping the turn", async () => {
  const f = fixture(true); await f.route("PUT", { bindings: [f.binding] }); f.hold();
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の依頼");
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "turn/start")).toBe(true));
  const answer = vi.fn(); f.ask({ id: "app-tool", nativeRequestId: 8, method: "item/tool/call", params: { threadId: "native-one", tool: "fixture" }, answer });
  expect(answer).not.toHaveBeenCalled(); f.complete();
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalled());
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.turnSucceeded === true)).toBe(true);
});
it("mediates before native submission and preserves the source message", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [{ ...f.binding, mediator: f.binding.formatter }] });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "仲介の架空の原文");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalled());
  expect(f.prepare).toHaveBeenCalledTimes(1);
  const started = f.calls.find(c => c.method === "turn/start");
  const payload = JSON.parse(started.params.input[0].text.split("\n").slice(1).join("\n"));
  expect(payload.user_request).toBe("仲介の架空の原文"); expect(payload.mediator_note).toBe("依頼を整理する。");
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.role === "user")?.text).toBe("仲介の架空の原文");
});
it("reports failed mediation visibly without submitting a native turn", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [{ ...f.binding, mediator: f.binding.formatter }] });
  f.prepare.mockRejectedValueOnce(Error("synthetic preparation failure"));
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の原文");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalled());
  expect(f.calls.some(c => c.method === "turn/start")).toBe(false);
  expect(f.store.messagesFor(f.bot.threadId).at(-1)?.text).toContain("Codexへは送信していません");
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  expect((await f.route("GET", undefined)).body.states[f.bot.threadId]).toBe("preparation-error");
});
it("forwards original input, keeps the original reply and asynchronously presents independent formatting", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [f.binding] });
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の原文");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalled());
  const answer = f.store.messagesFor(f.bot.threadId).find(m => m.nativeCodex?.turnId === "turn-new")!;
  expect(answer.text).toBe("短い回答"); expect(answer.nativeCodex?.originalText).toBe("詳細な元回答");
  expect(f.calls.find(c => c.method === "turn/start").params.input[0].text).toBe("架空の原文");
  expect(f.calls.filter(c => c.method === "turn/start")).toHaveLength(1);
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === source.id)?.requestPending).toBe(false);
  expect(f.clients.at(-1)?.close).toHaveBeenCalled();
});
it("keeps a writer conflict visible and never retries or falls back to the regular bot harness", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [f.binding] }); f.conflict();
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalled());
  expect(f.calls.filter(c => c.method === "turn/start")).toHaveLength(0); expect(f.format).not.toHaveBeenCalled();
  const failure = f.store.messagesFor(f.bot.threadId).at(-1)!;
  expect(failure.kind).toBe("text");
  expect(failure.text).toContain("自動再送はしていません");
  expect(failure.requestMessageId).toBe(source.id);
  expect(failure.turnSucceeded).toBe(false);
  expect(failure.turnTerminal).toBe(true);
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  expect((await f.route("GET", undefined)).body.states[f.bot.threadId]).toBe("writer-conflict");
  f.conflict(false);
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "新しい架空の入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
  expect((await f.route("GET", undefined)).body.states[f.bot.threadId]).toBe("idle");
  expect(f.calls.filter(c => c.method === "turn/start")).toHaveLength(1);
});
it("holds native approval for an explicit answer and preserves no session-wide grant", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [f.binding] }); f.hold();
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の入力");
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "turn/start")).toBe(true));
  const answer = vi.fn(); f.ask({ id: "native-permission", method: "item/commandExecution/requestApproval", params: { threadId: "native-one", command: "synthetic command" }, answer });
  expect(answer).not.toHaveBeenCalled();
  expect(f.service.answer(f.bot.threadId, "wrong", "allow")).toBeUndefined();
  expect(f.service.answer(f.bot.threadId, "native-permission", "allow")).toBe("allowed-once");
  expect(answer).toHaveBeenCalledWith({ decision: "accept" });
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalled());
});
it("imports new app-side user and assistant messages once, without generating another native turn", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [f.binding] });
  f.history([{ id: "old", status: "completed", items: [] }, { id: "app-turn", status: "completed", items: [{ id: "app-user", type: "userMessage", content: [{ type: "text", text: "アプリでの質問" }] }, { id: "app-answer", type: "agentMessage", text: "アプリでの回答" }] }]);
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.nativeCodex).map(m => m.nativeCodex?.originalText ?? m.text)).toEqual(["アプリでの質問", "アプリでの回答"]);
  expect(f.calls.filter(c => c.method === "turn/start")).toHaveLength(0);
});
it("does not let a failed app turn block subsequent successful conversation history", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [f.binding] });
  f.history([{ id: "old", status: "completed", items: [] }, { id: "failed-app", status: "failed", items: [] }, { id: "after-failure", status: "completed", items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "失敗後の回答" }] }]);
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  const rows = f.store.messagesFor(f.bot.threadId);
  expect(rows.some(m => m.turnId === "failed-app" && m.turnSucceeded === false)).toBe(true);
  expect(rows.some(m => m.nativeCodex?.originalText === "失敗後の回答")).toBe(true);
  expect(f.calls.filter(c => c.method === "turn/start")).toHaveLength(0);
});
it("reports an empty final answer instead of promoting commentary into a successful reply", async () => {
  const f = fixture(); await f.route("PUT", { bindings: [f.binding] });
  f.history([{ id: "old", status: "completed", items: [] }, { id: "empty-app", status: "completed", items: [{ id: "comment", type: "agentMessage", phase: "commentary", text: "これから操作します" }, { id: "final", type: "agentMessage", phase: "final_answer", text: "" }] }]);
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  await f.service.sync(f.service.binding(f.bot.id, f.bot.threadId)!);
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.turnId === "empty-app" && m.turnSucceeded === false)).toHaveLength(1);
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.nativeCodex?.originalText === "これから操作します")).toBe(false);
  expect(f.format).not.toHaveBeenCalled();
});

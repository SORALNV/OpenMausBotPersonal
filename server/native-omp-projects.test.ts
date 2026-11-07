import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { NativeOmpService } from "./native-omp-service.ts";
import { Store } from "./store.ts";
import type { NativeOmpTransport, OmpDestination } from "../scripts/native-omp-transport.mjs";
import type { RouteContext } from "./routes/table.ts";
const roots: string[] = [], services: NativeOmpService[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => { services.splice(0).forEach(service => service.close()); roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-project-fixture-")); roots.push(dir);
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })), bot = store.createBot({ name: "Synthetic Pi" });
  const shelf = store.createTask(bot.id, "MyShelf")!, mcp = store.createTask(bot.id, "MyMCP")!;
  const selection = { providerId: "fixture", modelId: "small", timeoutMs: 10000 };
  const binding = { botId: bot.id, enabled: true, host: "fixture.test", user: "fixture", binary: "/fixture/omp", stateRoot: "/fixture/sessions", profile: "fixture", cwd: "/fixture/work", model: "fixture/model", connection: "shared-tui", mediator: selection, formatter: selection };
  const sessions = [{ id: "shelf-id", name: "MyShelf", directory: "/fixture/sessions/shelf", running: true, shared: true }, { id: "mcp-id", name: "新しいセッション", directory: "/fixture/sessions/mcp", running: true, shared: true }];
  writeFileSync(join(dir, "native-omp.json"), JSON.stringify({ bindings: [binding] }), { mode: 0o600 });
  writeFileSync(join(dir, "native-omp-targets.json"), JSON.stringify({ [shelf.threadId]: { kind: "session", session: sessions[0] }, [mcp.threadId]: { kind: "session", session: sessions[1] } }), { mode: 0o600 });
  writeFileSync(join(dir, "native-omp-modes.json"), JSON.stringify({ [bot.threadId]: "router" }), { mode: 0o600 });
  const plan = { action: "chat", steps: [{ name: "MyShelf", request: "一覧の読み取りだけを確認" }, { name: "MyMCP", request: "前段の一覧とMCP側の読み取り結果を照合" }] };
  const generate = vi.fn(async (_provider: string, _model: string, _prompt: string) => JSON.stringify(plan)), settled = vi.fn(), catalog = vi.fn(async () => ({ sessions }));
  const failure: { sessionId?: string } = {};
  const sent: { sessionId: string; id: string; text: string }[] = [], clients: NativeOmpTransport[] = [];
  function open(destination: OmpDestination) {
    const client = Object.assign(new EventEmitter(), { closed: false, initialize: vi.fn(async () => ({ sessionId: destination.expectedSessionId!, sessionFile: "/fixture/history", resumed: true })),
      submit: vi.fn(async (id: string, text: string) => {
        sent.push({ sessionId: destination.expectedSessionId!, id, text });
        if (failure.sessionId === destination.expectedSessionId) throw Error("Connection lost");
        client.emit("nativeEntry", { role: "user", text, entryId: `entry-${id}`, sessionId: destination.expectedSessionId, own: true, activeOwn: true, snapshot: false });
        return { requestId: id, sessionId: destination.expectedSessionId!, sessionFile: "/fixture/history", text: `result-${destination.expectedSessionId}` };
      }), stop: vi.fn(async () => true), close: vi.fn(() => { client.closed = true; }), canSteer: () => true, requestStatus: () => "accepted" });
    clients.push(client as unknown as NativeOmpTransport); return client as unknown as NativeOmpTransport;
  }
  const create = () => { const service = new NativeOmpService({ dir, store, generate, formatter: { format: async () => "整形した総合回答" }, settled, catalog, sharedOpen: open }); services.push(service); return service; };
  const service = create();
  const route = async (path: string, method: string, body: unknown, scopes = ["admin"]) => {
    let result: { status: number; value: any } = { status: 0, value: undefined };
    await service.route({ path, method, auth: { scopes }, req: { url: path }, res: { setHeader() {} }, json: (_res: unknown, status: number, value: unknown) => { result = { status, value }; }, readBody: async () => body } as unknown as RouteContext);
    return result;
  };
  return { dir, store, bot, shelf, mcp, service, create, plan, generate, settled, catalog, sessions, sent, clients, failure, route };
}

it("one Manager routes across existing project sessions, preserving per-project originals and order without extra OMB threads", async () => {
  const f = fixture(), binding = f.service.binding(f.bot.id, f.bot.threadId)!;
  const original = "本棚の一覧とNAS連携を両方読み取りで確認して";
  const source = f.service.dispatch(binding, original);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.sent.map(item => item.sessionId)).toEqual(["shelf-id", "mcp-id"]);
  const second = JSON.parse(f.sent[1]!.text.split("\n").at(-1)!);
  expect(second.overall_request).toBe(original); expect(second.previous_results).toEqual([{ project: "MyShelf", sessionId: "shelf-id", text: "result-shelf-id" }]);
  const messages = f.store.messagesFor(f.bot.threadId), final = messages.find(message => message.turnTerminal && message.nativeOmp?.projects);
  expect(final?.nativeOmp?.projects?.map(result => result.sessionId)).toEqual(["shelf-id", "mcp-id"]);
  expect(final?.nativeOmp?.originalText).toContain("result-shelf-id"); expect(final?.nativeOmp?.originalText).toContain("result-mcp-id"); expect(final?.text).toBe("整形した総合回答");
  expect(messages.filter(message => message.turnTerminal)).toHaveLength(1); expect(messages.filter(message => message.role === "user")).toHaveLength(1);
  expect(f.store.bot(f.bot.id)!.tasks).toHaveLength(3); expect(f.service.status(f.bot.threadId)?.state).toBe("idle");
  const ledger = JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"));
  expect(ledger[source.id].stage).toBe("completed"); expect(f.sent.every(item => ledger[item.id].stage === "completed")).toBe(true);
  expect(ledger[source.id].admissionEntryId).toBe(`entry-${f.sent[1]!.id}`);
  f.service.close(); const restarted = f.create(); restarted.dispatch(restarted.binding(f.bot.id, f.bot.threadId)!, original, {}, source);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2)); expect(f.sent).toHaveLength(2);
});

it("owner project aliases use native IDs even when a session has a generic name, and reject unknown IDs and non-owner writes", async () => {
  const f = fixture(), path = "/api/native-omp/projects";
  const projects = [{ name: "MyMCP", description: "NASと連携APIのプロジェクト", sessionId: "mcp-id" }];
  expect((await f.route(path, "PUT", { botId: f.bot.id, threadId: f.bot.threadId, projects }, ["bot"])).status).toBe(403);
  expect((await f.route(path, "PUT", { botId: f.bot.id, threadId: f.bot.threadId, projects: [{ ...projects[0], sessionId: "invented" }] })).status).toBe(409);
  expect((await f.route(path, "PUT", { botId: f.bot.id, threadId: f.bot.threadId, projects })).status).toBe(200);
  f.plan.steps = [{ name: "MyMCP", request: "NASの連携だけ確認" }];
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "NASの連携を確認して");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce()); expect(f.sent[0]?.sessionId).toBe("mcp-id");
  expect(f.generate.mock.calls[0]?.[2]).toContain("NASと連携API");
});

it("invalid compound plans fail before any native submission", async () => {
  const f = fixture(); f.generate.mockResolvedValue(JSON.stringify({ action: "chat", steps: Array.from({ length: 5 }, () => ({ name: "MyShelf", request: "確認" })) }));
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "確認して");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce()); expect(f.sent).toHaveLength(0);
  expect(f.store.messagesFor(f.bot.threadId).find(message => message.turnTerminal)?.turnSucceeded).toBe(false);
});

it("a failed project does not run later stages, and completed results survive a restart", async () => {
  const f = fixture(); f.plan.steps.push({ name: "MyShelf", request: "後続の確認" });
  f.failure.sessionId = "mcp-id";
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "両方確認して");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.sent.map(item => item.sessionId)).toEqual(["shelf-id", "mcp-id"]);
  const messages = f.store.messagesFor(f.bot.threadId);
  expect(messages.some(message => message.nativeOmp?.originalText === "result-shelf-id")).toBe(true);
  expect(messages.find(message => message.turnTerminal)?.turnSucceeded).toBe(false);
  const ledger = JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"));
  expect(ledger[f.sent[0]!.id].stage).toBe("completed"); expect(ledger[f.sent[1]!.id].stage).toBe("indeterminate");
  f.service.close(); f.create(); expect(f.sent).toHaveLength(2);
});

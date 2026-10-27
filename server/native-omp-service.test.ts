import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeOmpTransport, OmpDestination } from "../scripts/native-omp-transport.mjs";
import { DATA_DIR } from "./config.ts";
import { NativeOmpService } from "./native-omp-service.ts";
import { NativeOmpCollab } from "../scripts/native-omp-collab.mjs";
import { saveImage } from "./attachments.ts";
import { Store } from "./store.ts";
import type { RouteContext } from "./routes/table.ts";
import { formatQuestionAnswers } from "../shared/ask-question.ts";

const dirs: string[] = [], services: NativeOmpService[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => { services.splice(0).forEach(service => service.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-native-omp-test-")); dirs.push(dir);
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Synthetic Pi" });
  const selection = { providerId: "fixture", modelId: "fixture-small", timeoutMs: 1000 };
  const binding = { botId: bot.id, enabled: true, host: "fixture.test", user: "fixture", binary: "/fixture/omp", stateRoot: "/fixture/threads", profile: "fixture", cwd: "/fixture/workspace", model: "fixture/model", mediator: selection };
  writeFileSync(join(dir, "native-omp.json"), JSON.stringify({ bindings: [binding] }), { mode: 0o600 });
  const generate = vi.fn(async (_provider: string, _model: string, _prompt: string, _signal: AbortSignal, _images?: readonly import("./contracts.ts").TurnImageInput[]) => JSON.stringify({ action: "chat", note: "架空の整理メモ" }));
  const open = vi.fn((_binding: OmpDestination) => {
    const client = new EventEmitter();
    return Object.assign(client, { initialize: vi.fn(async () => ({ sessionId: "native-one", sessionFile: "/fixture/session", resumed: true })),
      submit: vi.fn(async (requestId: string) => ({ requestId, sessionId: "native-one", sessionFile: "/fixture/session", text: "架空の回答" })),
      stop: vi.fn(async () => true), close: vi.fn() }) as unknown as NativeOmpTransport;
  });
  const settled = vi.fn();
  const formatter = vi.fn(async (_input: Parameters<import("./direct-thread-bridge.ts").ReplyFormatter["format"]>[0]) => "短い回答");
  const localTurn = vi.fn(async (_input: { botId: string; threadId: string; text: string; source: import("./store.ts").Message; signal: AbortSignal }) => "OMB管理の結果です。");
  const create = () => {
    const service = new NativeOmpService({ dir, store, generate, localTurn, open, sharedOpen: binding => NativeOmpCollab.connect(binding, { timeoutMs: 90000 }), formatter: { format: formatter }, settled });
    services.push(service); return service;
  };
  const service = create();
  return { dir, bot, store, generate, localTurn, open, settled, formatter, create, service, binding };
}

it("automatically pins each Bot thread while refusing another Bot's thread", () => {
  const f = fixture();
  const next = f.store.createTask(f.bot.id, "Separate synthetic thread")!;
  const other = f.store.createBot({ name: "Other synthetic Bot" });
  expect(f.service.binding(f.bot.id, f.bot.threadId)?.threadId).toBe(f.bot.threadId);
  expect(f.service.binding(f.bot.id, next.threadId)?.threadId).toBe(next.threadId);
  expect(f.service.binding(f.bot.id, other.threadId)).toBeUndefined();
  expect(f.service.binding(other.id, other.threadId)).toBeUndefined();
});

it("retains a completed durable receipt when the same source is presented after a restart", async () => {
  const f = fixture();
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
  f.service.close();
  const before = f.open.mock.calls.length, preparation = f.generate.mock.calls.length;
  const restarted = f.create();
  restarted.dispatch(restarted.binding(f.bot.id, f.bot.threadId)!, "架空の入力", {}, source);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
  expect(f.open.mock.calls.length).toBe(before);
  expect(f.generate.mock.calls.length).toBe(preparation);
  expect(JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"))[source.id].stage).toBe("completed");
});

it("does not replay or relabel a submitted indeterminate request after restart", async () => {
  const f = fixture();
  const source = f.store.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "架空の未完了入力" });
  const digest = createHash("sha256").update(JSON.stringify([f.bot.id, f.bot.threadId, source.text])).digest("hex");
  writeFileSync(join(f.dir, "native-omp-ledger.json"), JSON.stringify({ [source.id]: { digest, stage: "submitted", sessionId: "native-one" } }), { mode: 0o600 });
  const restarted = f.create();
  restarted.dispatch(restarted.binding(f.bot.id, f.bot.threadId)!, source.text!, {}, source);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"))[source.id].stage).toBe("submitted");
});

it("Stop cancels an uncooperative preparation model without opening SSH", async () => {
  const f = fixture(); f.generate.mockImplementation(() => new Promise(() => {}));
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の停止テスト");
  expect(await f.service.stop(f.bot.threadId)).toBe(true);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled();
  expect(f.store.messagesFor(f.bot.threadId).find(message => message.id === source.id)?.requestCancelled).toBe(true);
});

it("invalid mediation never falls through to sending the original request", async () => {
  const f = fixture(); f.generate.mockResolvedValue("");
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の遮断テスト");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled();
  expect(f.store.messagesFor(f.bot.threadId).filter(message => message.turnTerminal).at(-1)?.turnSucceeded).toBe(false);
});

it("a non-owner cannot inspect or change the native destination", async () => {
  const f = fixture(); let status = 0;
  await f.service.route({ path: "/api/native-omp", method: "GET", auth: { scopes: ["client"] }, res: {}, json: (_res: unknown, code: number) => { status = code; } } as unknown as RouteContext);
  expect(status).toBe(403);
});

it("attachments cannot reach the native conversation as text markers", () => {
  const f = fixture();
  expect(() => f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, '<attached-file path="/private/file" />')).toThrow(/未対応/);
  expect(f.generate).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});

function sharedFixture(approvalPolicy?: "mediator") {
  const f = fixture(); f.service.close();
  const native = f.open({} as OmpDestination);
  vi.spyOn(NativeOmpCollab, "connect").mockReturnValue(native as NativeOmpCollab);
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui", ...(approvalPolicy ? { approvalPolicy } : {}) }] }), { mode: 0o600 });
  const service = f.create();
  return { ...f, service, native };
}

it("shared TUI sends exact ordinary text and retains one native connection across BOT turns", async () => {
  const f = sharedFixture(); const binding = f.service.binding(f.bot.id, f.bot.threadId)!;
  f.service.dispatch(binding, "そのままの原文");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.native.submit).toHaveBeenCalledWith(expect.any(String), "そのままの原文");
  expect(f.native.close).not.toHaveBeenCalled();
  f.service.dispatch(binding, "次の原文");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
  expect(NativeOmpCollab.connect).toHaveBeenCalledOnce();
});

it("native human inputs and answers appear in OMB once and replication survives restart", () => {
  const f = sharedFixture(); f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "先行BOT入力");
  return vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce()).then(() => {
    const entry = { entryId: "human-one", role: "user", text: "TUIからの架空入力", sessionId: "native-one", own: false, activeOwn: false, snapshot: false };
    f.native.emit("nativeEntry", entry); f.native.emit("nativeEntry", entry);
    f.native.emit("nativeEntry", { ...entry, entryId: "reply-one", role: "assistant", text: "TUIへの架空回答" });
    expect(f.store.messagesFor(f.bot.threadId).filter(m => m.text === entry.text)).toHaveLength(1);
    expect(f.store.messagesFor(f.bot.threadId).find(m => m.text === "TUIへの架空回答")?.nativeOmp?.source).toBe("human");
    f.service.close(); const restart = f.create(); restart.start(); f.native.emit("nativeEntry", { ...entry, snapshot: true });
    expect(f.store.messagesFor(f.bot.threadId).filter(m => m.text === entry.text)).toHaveLength(1);
  });
});

it("concurrent native human input is labelled as a shared response", async () => {
  const f = sharedFixture();
  vi.mocked(f.native.submit).mockResolvedValue({ requestId: "fixture", sessionId: "native-one", sessionFile: "/fixture/session", text: "共同の回答", sharedTurn: true });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "BOTからの架空入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  const reply = f.store.messagesFor(f.bot.threadId).find(m => m.nativeOmp?.sharedTurn);
  expect(reply?.text).toContain("共有ターン"); expect(reply?.nativeOmp?.originalText).toBe("共同の回答");
});

it("a detached shared connector is replaced before the next explicit BOT input", async () => {
  const f = sharedFixture(); const binding = f.service.binding(f.bot.id, f.bot.threadId)!;
  f.service.dispatch(binding, "最初の原文");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  Object.assign(f.native, { closed: true });
  const next = f.open({} as OmpDestination);
  vi.mocked(NativeOmpCollab.connect).mockReturnValue(next as NativeOmpCollab);
  f.service.dispatch(binding, "切断後の明示入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
  expect(NativeOmpCollab.connect).toHaveBeenCalledTimes(2);
  expect(next.submit).toHaveBeenCalledWith(expect.any(String), "切断後の明示入力");
});

function reviewingFixture() {
  const f = fixture(); f.service.close();
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, approvalPolicy: "mediator" }] }), { mode: 0o600 });
  let finish!: (value: { requestId: string; sessionId: string; sessionFile: string; text: string }) => void;
  const client = Object.assign(new EventEmitter(), {
    initialize: vi.fn(async () => ({ sessionId: "native-one", sessionFile: "/fixture/session", resumed: true })),
    submit: vi.fn(() => new Promise(resolve => { finish = resolve; })),
    answerUi: vi.fn(), stop: vi.fn(async () => true), close: vi.fn(),
  });
  f.open.mockReturnValue(client as unknown as NativeOmpTransport);
  const service = f.create();
  service.dispatch(service.binding(f.bot.id, f.bot.threadId)!, "接続ディスクを調べて");
  return { ...f, service, client, complete: () => finish({ requestId: "fixture", sessionId: "native-one", sessionFile: "/fixture/session", text: "架空の完了" }) };
}

it("mediator proceeds when no high risk is detected without an owner card", async () => {
  const f = reviewingFixture();
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.client.emit("question", { id: "inspection", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: lsblk -o NAME,SIZE", options: ["Approve", "Approve bash for this session", "Deny"] });
  await vi.waitFor(() => expect(f.client.answerUi).toHaveBeenCalledWith("inspection", { value: "Approve" }));
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.card?.requestType === "permission")).toHaveLength(0);
  expect(f.generate).toHaveBeenCalledTimes(2);
  f.complete();
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
});

it("disk formatting still needs a human even with an always-allow model", async () => {
  const f = reviewingFixture();
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.client.emit("question", { id: "format", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: mkfs.ext4 /dev/sda", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  expect(f.client.answerUi).not.toHaveBeenCalled();
  expect(f.generate).toHaveBeenCalledTimes(1);
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  expect(await f.service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
  expect(f.client.answerUi).toHaveBeenCalledWith("format", { value: "Deny" });
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
});

it("a late review cannot answer a question already settled by the human TUI", async () => {
  const f = reviewingFixture();
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  let finishReview!: (value: string) => void;
  f.generate.mockImplementation(() => new Promise<string>(resolve => { finishReview = resolve; }));
  f.client.emit("question", { id: "cancelled", method: "select", title: "Allow tool: bash", message: "Command: lsblk", options: ["Approve", "Deny"] });
  f.client.emit("questionCancelled", "cancelled");
  finishReview('{"highRisk":false}');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.client.answerUi).not.toHaveBeenCalled();
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(false);
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
});

it("shared native approval listeners survive completed BOT turns", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "先行の架空入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("question", { id: "after-turn", method: "select", title: "Allow tool: write\nPath: proc://fixture", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  expect(await f.service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
  expect(f.native.answerUi).toHaveBeenCalledWith("after-turn", { value: "Deny" });
  expect(f.native.listenerCount("question")).toBe(1);
});

it("shared pending approvals remain reachable after a BOT request fails", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() });
  vi.mocked(f.native.submit).mockRejectedValue(new Error("synthetic timeout"));
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の失敗入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("question", { id: "orphan", method: "select", title: "Allow tool: bash\nCommand: systemctl restart fixture", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  expect(await f.service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
  expect(f.native.answerUi).toHaveBeenCalledWith("orphan", { value: "Deny" });
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it("a replayed shared approval is surfaced immediately on startup without a new user prompt", async () => {
  const f = sharedFixture(); f.service.close();
  Object.assign(f.native, { answerUi: vi.fn() });
  writeFileSync(join(f.dir, "native-omp-sessions.json"), JSON.stringify({ [f.bot.threadId]: "native-one" }), { mode: 0o600 });
  vi.mocked(f.native.initialize).mockImplementation(async () => {
    f.native.emit("question", { id: "replayed", method: "select", title: "Allow tool: write\nPath: proc://synthetic", options: ["Approve", "Deny"] });
    return { sessionId: "native-one", sessionFile: "/fixture/session", resumed: true, cancelled: false };
  });
  const service = f.create(); service.start();
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  expect(await service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
  expect(f.native.answerUi).toHaveBeenCalledWith("replayed", { value: "Deny" });
  expect(f.native.submit).not.toHaveBeenCalled();
});

it("disconnecting a prompt still waiting in the shared queue is recorded as not sent", async () => {
  const f = sharedFixture(); Object.assign(f.native, { requestStatus: vi.fn(() => "queued") });
  vi.mocked(f.native.submit).mockRejectedValue(new Error("synthetic queued disconnect"));
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "未送信の架空入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"))[source.id].stage).toBe("not-sent");
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.turnTerminal).at(-1)?.text).toContain("まだ送信していません");
});

it("reconnects a detached native reader and imports missed history without another prompt", async () => {
  const f = sharedFixture();
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "送信済みの架空入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  const preparationCount = f.generate.mock.calls.length;
  Object.assign(f.native, { closed: true });
  const next = f.open({} as OmpDestination);
  vi.mocked(NativeOmpCollab.connect).mockReturnValue(next as NativeOmpCollab);
  f.native.emit("disconnected", "connection lost");
  await vi.waitFor(() => expect(next.initialize).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(next.submit).not.toHaveBeenCalled(); expect(f.generate.mock.calls.length).toBe(preparationCount);
  const entry = { entryId: "missed-terminal-answer", role: "assistant", text: "Piで生成済みの架空回答", sessionId: "native-one", own: false, activeOwn: false, snapshot: true };
  f.native.emit("nativeEntry", { ...entry, entryId: "stale-reader", text: "旧接続の遅延イベント" });
  next.emit("nativeEntry", { ...entry, entryId: "foreign-reader", sessionId: "another-session", text: "別セッション" });
  next.emit("nativeEntry", entry); next.emit("nativeEntry", entry);
  const messages = f.store.messagesFor(f.bot.threadId);
  expect(messages.filter(message => message.text === entry.text)).toHaveLength(1);
  expect(messages.some(message => ["旧接続の遅延イベント", "別セッション"].includes(message.text ?? ""))).toBe(false);
});

it("shutdown cancels native reconnection instead of reviving a closed service", async () => {
  const f = sharedFixture();
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の終了確認");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("disconnected", "connection lost"); f.service.close();
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(NativeOmpCollab.connect).toHaveBeenCalledOnce();
});

it("does not send unsolicited developer reports or show the English reporting dialog", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の作業");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("question", { id: "report", method: "select", title: "👻 Your agent swears one of its tools is haunted.\nCall in the devs for an exorcism? Tool name + the spooky bit, nothing personal.", options: ["Yes", "No"] });
  await vi.waitFor(() => expect(f.native.answerUi).toHaveBeenCalledWith("report", { value: "No" }));
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.subtitle?.includes("haunted"))).toBe(false);
  expect(f.native.submit).toHaveBeenCalledOnce();
});

it("renders ordinary native questions as questions and maps Japanese choices to original native values", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の作業");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.generate.mockResolvedValue('{"question":"どちらを続けますか？","options":["最初","次"]}');
  f.native.emit("question", { id: "which", method: "select", title: "Which one?", options: ["First", "Next"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.questionRequest)).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.questionRequest)!.card!;
  expect(card.tool).toBeUndefined(); expect(card.requestType).toBe("question");
  expect(await f.service.answer(f.bot.threadId, card.requestId!, "allow")).toBe("unavailable");
  expect(await f.service.answer(f.bot.threadId, card.requestId!, "answer", formatQuestionAnswers(card.questionRequest!.questions, [["次"]]))).toBe("answered");
  expect(f.native.answerUi).toHaveBeenCalledWith("which", { value: "Next" });
});

it("recovers the review context from admitted history after a failed BOT turn, but never lends it to a human turn", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() });
  f.service.close();
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui", approvalPolicy: "mediator" }] }), { mode: 0o600 });
  const service = f.create();
  vi.mocked(f.native.submit).mockRejectedValue(new Error("synthetic disconnect"));
  service.dispatch(service.binding(f.bot.id, f.bot.threadId)!, "ディスクの容量を調べて");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry", { entryId: "admission", role: "user", text: "ディスクの容量を調べて", sessionId: "native-one", own: true, activeOwn: false, snapshot: true });
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.native.emit("question", { id: "inspection-after-failure", method: "select", title: "Allow tool: bash\nCommand: lsblk", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.native.answerUi).toHaveBeenCalledWith("inspection-after-failure", { value: "Approve" }));
  f.native.emit("nativeEntry", { entryId: "human", role: "user", text: "人間から別の作業", sessionId: "native-one", own: false, activeOwn: false, snapshot: false });
  f.native.emit("question", { id: "human-inspection", method: "select", title: "Allow tool: bash\nCommand: lsblk", options: ["Approve", "Deny"] });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true);
  expect(f.native.answerUi).toHaveBeenCalledTimes(1); expect(f.native.submit).toHaveBeenCalledOnce();
});

it("reconciles an interrupted receipt only after its own admission, final answer and idle state, without replay", async () => {
  const f = sharedFixture();
  vi.mocked(f.native.submit).mockRejectedValue(new Error("synthetic interrupted connection"));
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の復旧対象");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  const receipt = () => JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"))[source.id];
  expect(receipt().stage).toBe("indeterminate");
  f.native.emit("nativeEntry", { entryId: "own-recovered", role: "user", text: source.text, sessionId: "native-one", own: true, activeOwn: false, snapshot: true });
  f.native.emit("nativeEntry", { entryId: "final-recovered", role: "assistant", text: "架空の最終回答", stopReason: "stop", sessionId: "native-one", own: false, activeOwn: false, snapshot: true });
  expect(receipt().stage).toBe("indeterminate");
  f.native.emit("nativeState", { busy: false });
  expect(receipt()).toMatchObject({ stage: "completed", admissionEntryId: "own-recovered" });
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.nativeOmp?.entryId === "final-recovered"))
    .toMatchObject({ requestMessageId: source.id, turnSucceeded: true, nativeOmp: { requestId: source.id } });
  expect(f.native.submit).toHaveBeenCalledOnce();
});

it("cannot use a foreign human answer to settle an interrupted BOT receipt", async () => {
  const f = sharedFixture();
  vi.mocked(f.native.submit).mockRejectedValue(new Error("synthetic interruption"));
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "元の架空入力");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry", { entryId: "admitted", role: "user", text: source.text, sessionId: "native-one", own: true, activeOwn: false, snapshot: true });
  f.native.emit("nativeEntry", { entryId: "human-new", role: "user", text: "別の依頼", sessionId: "native-one", own: false, activeOwn: false, snapshot: true });
  f.native.emit("nativeEntry", { entryId: "human-final", role: "assistant", text: "別の依頼の回答", stopReason: "stop", sessionId: "native-one", own: false, activeOwn: false, snapshot: true });
  f.native.emit("nativeState", { busy: false });
  expect(JSON.parse(readFileSync(join(f.dir, "native-omp-ledger.json"), "utf8"))[source.id].stage).toBe("indeterminate");
});

it("restores completed BOT authorization for native background work after restart without lending it to a new human", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn(), recentFileWrites: vi.fn(() => [{ path: "tests/test_a.py", content: "import unittest\n" }]) });
  f.service.close();
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui", approvalPolicy: "mediator" }] }), { mode: 0o600 });
  const service = f.create(); const source = service.dispatch(service.binding(f.bot.id, f.bot.threadId)!, "プロジェクトのコードとテストを作って");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce()); service.close();
  const restart = f.create(); restart.start();
  f.native.emit("nativeEntry", { entryId: "completed-own", role: "user", text: source.text, sessionId: "native-one", own: true, activeOwn: false, snapshot: true });
  f.native.emit("nativeEntry", { entryId: "native-background", role: "system", text: "Background completed", sessionId: "native-one", own: false, activeOwn: false, snapshot: true });
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.native.emit("question", { id: "background-test", method: "select", title: "Allow tool: bash\nCommand: .venv/bin/python -m unittest discover -s tests -v", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.native.answerUi).toHaveBeenCalledWith("background-test", { value: "Approve" }));
  f.native.emit("nativeEntry", { entryId: "next-human", role: "user", text: "別の人間の作業", sessionId: "native-one", own: false, activeOwn: false, snapshot: false });
  f.native.emit("question", { id: "human-next", method: "select", title: "Allow tool: bash\nCommand: command -v python3", options: ["Approve", "Deny"] });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true);
  expect(f.native.answerUi).toHaveBeenCalledTimes(1); expect(f.native.submit).toHaveBeenCalledOnce();
});

it("closing OMB detaches shared native work without sending a native Stop", async () => {
  const f = sharedFixture(); vi.mocked(f.native.submit).mockImplementation(() => new Promise(() => {}));
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の継続作業");
  await vi.waitFor(() => expect(f.native.submit).toHaveBeenCalledOnce()); f.service.close();
  expect(f.native.stop).not.toHaveBeenCalled(); expect(f.native.close).toHaveBeenCalled();
});

it("an active OMB request never authorizes a new human native turn", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() }); f.service.close();
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui", approvalPolicy: "mediator" }] }), { mode: 0o600 });
  vi.mocked(f.native.submit).mockImplementation(() => new Promise(() => {})); const service = f.create();
  const source = service.dispatch(service.binding(f.bot.id, f.bot.threadId)!, "元のBOT作業");
  await vi.waitFor(() => expect(f.native.submit).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry", { entryId: "active-admission", role: "user", text: source.text, sessionId: "native-one", own: true, activeOwn: true, snapshot: false });
  f.native.emit("nativeEntry", { entryId: "active-human", role: "user", text: "新しい人間の依頼", sessionId: "native-one", own: false, activeOwn: true, snapshot: false });
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.native.emit("question", { id: "human-during-bot", method: "select", title: "Allow tool: bash\nCommand: lsblk", options: ["Approve", "Deny"] });
  await new Promise(resolve => setImmediate(resolve)); expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true); expect(f.native.answerUi).not.toHaveBeenCalled();
});

it("reads fresh edited source before reviewing execution and carries same-request human approvals", async () => {
  const f = reviewingFixture();
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  Object.assign(f.client, {
    recentFileWrites: vi.fn(() => [{ path: "tests/test_fixture.py", content: "stale before edit" }]),
    reviewFiles: vi.fn(async () => [{ path: "tests/test_fixture.py", content: "fresh after native edit" }]),
  });
  f.generate.mockResolvedValue('{"highRisk":true,"reason":"重要な対象の変更が含まれます。"}');
  f.client.emit("question", { id: "first", method: "select", title: "Allow tool: bash\nCommand: lsblk -o NAME,SIZE", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestId)).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestId)!;
  expect(card.requestMessageId).toBeTruthy();
  expect(await f.service.answer(f.bot.threadId, card.card!.requestId!, "allow")).toBe("allowed-once");
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.client.emit("question", { id: "tests", method: "select", title: "Allow tool: bash\nCommand: python3 -m unittest discover -s tests -v", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.client.answerUi).toHaveBeenCalledWith("tests", { value: "Approve" }));
  expect(f.generate).toHaveBeenLastCalledWith("fixture", "fixture-small", expect.stringContaining("fresh after native edit"), expect.any(AbortSignal));
  expect(f.generate).toHaveBeenLastCalledWith("fixture", "fixture-small", expect.stringContaining('human_approved_operations'), expect.any(AbortSignal));
  expect(f.generate).toHaveBeenLastCalledWith("fixture", "fixture-small", expect.stringContaining('lsblk -o NAME,SIZE'), expect.any(AbortSignal));
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.card?.requestType === "permission")).toHaveLength(1);
  f.complete();
});

it("revokes an in-flight model approval when a human takes over the shared TUI", async () => {
  const f = sharedFixture(); Object.assign(f.native, { answerUi: vi.fn() }); f.service.close();
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui", approvalPolicy: "mediator" }] }), { mode: 0o600 });
  const service=f.create();const source=service.dispatch(service.binding(f.bot.id,f.bot.threadId)!,"接続状態を確認して");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry",{entryId:"owned",role:"user",text:source.text,sessionId:"native-one",own:true,snapshot:true});
  let finish!: (text:string)=>void;
  f.generate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  f.native.emit("question",{id:"in-flight",method:"select",title:"Allow tool: bash\nCommand: lsblk",options:["Approve","Deny"]});
  await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
  f.native.emit("nativeEntry",{entryId:"takeover",role:"user",text:"人間による別作業",sessionId:"native-one",own:false,snapshot:false});
  finish('{"highRisk":false}');
  await new Promise(resolve => setImmediate(resolve));
  expect(f.store.messagesFor(f.bot.threadId).some(m=>m.card?.requestType === "permission")).toBe(true);
  expect(f.native.answerUi).not.toHaveBeenCalled();
});

it("does not require positive low-risk proof for an unfamiliar command or outside-workspace edit", async () => {
  const f=reviewingFixture();await vi.waitFor(()=>expect(f.client.submit).toHaveBeenCalledOnce());
  f.generate.mockResolvedValue('{"highRisk":false}');
  for(const [id,title]of [["unfamiliar","Allow tool: bash\nCommand: arbitrary-project-tool verify --format custom"],["outside-edit","Allow tool: edit\nFile: /home/rasp/agent-home/docs/guide.md"]]) {
    f.client.emit("question",{id,method:"select",title,options:["Approve","Deny"]});
    await vi.waitFor(()=>expect(f.client.answerUi).toHaveBeenCalledWith(id,{value:"Approve"}));
  }
  expect(f.store.messagesFor(f.bot.threadId).filter(m=>m.card?.requestType==="permission")).toHaveLength(0);f.complete();
});

it("retries classifier failures without turning them into owner approval requests or executing the action", async () => {
  const f=reviewingFixture();await vi.waitFor(()=>expect(f.client.submit).toHaveBeenCalledOnce());
  f.generate.mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue('{"highRisk":false}');
  f.client.emit("question",{id:"retry-then-proceed",method:"select",title:"Allow tool: bash\nCommand: make verify",options:["Approve","Deny"]});
  await vi.waitFor(()=>expect(f.store.messagesFor(f.bot.threadId).some(m=>m.text?.includes("高リスク判定を再試行"))).toBe(true));
  expect(f.client.answerUi).not.toHaveBeenCalled();expect(f.store.messagesFor(f.bot.threadId).some(m=>m.card?.requestType==="permission")).toBe(false);
  await vi.waitFor(()=>expect(f.client.answerUi).toHaveBeenCalledWith("retry-then-proceed",{value:"Approve"}),{timeout:3500});
  expect(f.store.messagesFor(f.bot.threadId).filter(m=>m.text?.includes("Pi / OhMyPi に依頼中"))).toHaveLength(1);f.complete();
});

it("shows an approval card only for a concrete high-risk finding and includes its reason", async () => {
  const f=reviewingFixture();await vi.waitFor(()=>expect(f.client.submit).toHaveBeenCalledOnce());
  f.generate.mockResolvedValue('{"highRisk":true,"reason":"この操作はNASの重要なバックアップを削除します。"}');
  f.client.emit("question",{id:"concrete-risk",method:"select",title:"Allow tool: bash\nCommand: project-storage-tool apply",options:["Approve","Deny"]});
  await vi.waitFor(()=>expect(f.store.messagesFor(f.bot.threadId).some(m=>m.card?.subtitle?.includes("NASの重要なバックアップを削除"))).toBe(true));
  expect(f.client.answerUi).not.toHaveBeenCalled();f.complete();
});

it("keeps native progress after a shared job disconnect and folds it into the recovered final turn", async () => {
  const f=sharedFixture();vi.mocked(f.native.submit).mockRejectedValue(new Error("synthetic disconnect"));
  const source=f.service.dispatch(f.service.binding(f.bot.id,f.bot.threadId)!,"接続を確認してテストして");
  await vi.waitFor(()=>expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry",{entryId:"progress-own",role:"user",text:source.text,sessionId:"native-one",own:true,activeOwn:false,snapshot:true});
  f.native.emit("nativeTool",{type:"tool_execution_start",toolName:"read"});
  const progress=f.store.messagesFor(f.bot.threadId).findLast(m=>m.text?.includes("Pi / OhMyPi に依頼中"))!;
  expect(progress.text).toContain("ファイル・情報の確認を進めています");expect(progress.turnTerminal).not.toBe(true);
  f.native.emit("nativeTool",{type:"tool_execution_end",toolName:"read",isError:false});
  expect(f.store.messagesFor(f.bot.threadId).find(m=>m.id===progress.id)?.text).toContain("が終わりました");
  f.native.emit("nativeEntry",{entryId:"native-narration",role:"assistant",text:"疎通を確認しました。次にテストします。",stopReason:"toolUse",sessionId:"native-one",own:false,activeOwn:false,snapshot:false});
  expect(f.store.messagesFor(f.bot.threadId).filter(m=>m.nativeOmp?.entryId==="native-narration")).toHaveLength(1);
  f.native.emit("nativeEntry",{entryId:"native-final",role:"assistant",text:"検証が完了しました。",stopReason:"stop",sessionId:"native-one",own:false,activeOwn:false,snapshot:false});
  f.native.emit("nativeState",{busy:false});
  const final=f.store.messagesFor(f.bot.threadId).find(m=>m.nativeOmp?.entryId==="native-final")!;
  expect(final).toMatchObject({turnId:progress.turnId,turnTerminal:true,turnSucceeded:true,requestMessageId:source.id});
  expect(f.native.submit).toHaveBeenCalledOnce();
});

it("uses a new foldable progress turn for native work continuing after a completed request", async () => {
  const f=sharedFixture();const source=f.service.dispatch(f.service.binding(f.bot.id,f.bot.threadId)!,"確認して");
  await vi.waitFor(()=>expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry",{entryId:"continuation-own",role:"user",text:source.text,sessionId:"native-one",own:true,activeOwn:false,snapshot:true});
  f.native.emit("nativeTool",{type:"tool_execution_start",toolName:"bash"});
  const progress=f.store.messagesFor(f.bot.threadId).findLast(m=>m.text?.includes("Pi / OhMyPi に依頼中"))!;
  expect(progress.turnId).not.toBe(`omp-${source.id}`);
  f.native.emit("nativeEntry",{entryId:"continuation-final",role:"assistant",text:"追加の確認も完了です。",stopReason:"stop",sessionId:"native-one",own:false,activeOwn:false,snapshot:false});
  expect(f.store.messagesFor(f.bot.threadId).find(m=>m.nativeOmp?.entryId==="continuation-final")).toMatchObject({turnId:progress.turnId,turnTerminal:true});
});

it("explicit owner consent approves a high-risk tool once and records actual execution", async () => {
  const f = reviewingFixture();
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  Object.assign(f.client, { pendingOperation: () => ({ id: "call-one", name: "bash", arguments: { command: "sudo systemctl restart fixture" } }) });
  const q = { id: "consented-restart", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: sudo systemctl restart fixture", options: ["Approve", "Approve bash for this session", "Deny"] };
  f.client.emit("question", q);
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  f.service.ownerConsent(f.bot.id, f.bot.threadId, "すべて許可", "consent-send-one");
  await vi.waitFor(() => expect(f.client.answerUi).toHaveBeenCalledWith(q.id, { value: "Approve" }));
  const audit = () => f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestId?.startsWith("native-omp-audit-"))!;
  expect(audit().card?.answered).toBe("allow");
  expect(audit().card?.subtitle).toContain("開始は未確認");
  f.client.emit("nativeTool", { type: "tool_execution_end", toolName: "bash", toolCallId: "unrelated", isError: false });
  expect(audit().card?.subtitle).toContain("開始は未確認");
  f.client.emit("nativeTool", { type: "tool_execution_start", toolName: "bash", toolCallId: "call-one" });
  expect(audit().card?.subtitle).toContain("実行開始を確認");
  f.client.emit("nativeTool", { type: "tool_execution_end", toolName: "bash", toolCallId: "call-one", isError: true });
  expect(audit().card?.subtitle).toContain("実行終了（エラー）");
  expect(f.client.answerUi).toHaveBeenCalledTimes(1);
  f.service.ownerConsent(f.bot.id, f.bot.threadId, "すべて許可", "consent-send-one");
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.sendId === "consent-send-one")).toHaveLength(1);
  expect(() => f.service.ownerConsent(f.bot.id, f.bot.threadId, "取り消し", "consent-send-one")).toThrow(/送信ID/);
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
});

it("revocation restores high-risk questions without revoking the native work", async () => {
  const f = reviewingFixture(); await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  f.service.ownerConsent(f.bot.id, f.bot.threadId, "全部許可します");
  f.service.ownerConsent(f.bot.id, f.bot.threadId, "すべて許可を取り消して");
  f.client.emit("question", { id: "after-revoke", method: "select", title: "Allow tool: bash", message: "Command: sudo reboot", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission" && !m.card.answered)).toBe(true));
  expect(f.client.answerUi).not.toHaveBeenCalled(); expect(f.client.stop).not.toHaveBeenCalled();
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
});

it("an idle grant covers only the next request, and cannot survive Stop or restart", async () => {
  const f = reviewingFixture(); await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.service.ownerConsent(f.bot.id, f.bot.threadId, "全て許可");
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の次の作業");
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(2));
  f.client.emit("question", { id: "next-job", method: "select", title: "Allow tool: bash", message: "Command: sudo reboot", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.client.answerUi).toHaveBeenCalledTimes(1));
  f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の三番目の作業");
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(3));
  f.client.emit("question", { id: "third-job", method: "select", title: "Allow tool: bash", message: "Command: sudo reboot", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestId && !m.card.answered && !m.card.expired)).toBe(true));
  expect(f.client.answerUi).toHaveBeenCalledTimes(1);
  await f.service.stop(f.bot.threadId); f.complete(); await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(3));
  f.service.ownerConsent(f.bot.id, f.bot.threadId, "全て許可"); f.service.close();
  const restarted = f.create(); restarted.dispatch(restarted.binding(f.bot.id, f.bot.threadId)!, "再起動後の架空作業");
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(4));
  f.client.emit("question", { id: "after-restart", method: "select", title: "Allow tool: bash", message: "Command: sudo reboot", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestId && !m.card.answered && !m.card.expired)).toBe(true));
  expect(f.client.answerUi).toHaveBeenCalledTimes(1); f.complete();
});


it("idle shared-state refresh does not consume a grant for the next request", async () => {
  const f = sharedFixture(); f.service.close();
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui", approvalPolicy: "mediator" }] }), { mode: 0o600 });
  const service = f.create();
  Object.assign(f.native, { answerUi: vi.fn() });
  let finish!: (value: Awaited<ReturnType<NativeOmpTransport["submit"]>>) => void;
  vi.mocked(f.native.submit).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  service.start();
  service.ownerConsent(f.bot.id, f.bot.threadId, "全て許可");
  f.native.emit("nativeState", { busy: false });
  service.dispatch(service.binding(f.bot.id, f.bot.threadId)!, "次の架空のサービス更新");
  await vi.waitFor(() => expect(f.native.submit).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry", { entryId: "owned-input", role: "user", text: "次の架空のサービス更新", own: true, activeOwn: true, snapshot: false, sessionId: "native-one" });
  f.native.emit("question", { id: "idle-grant-tool", method: "select", title: "Allow tool: bash", message: "Command: sudo systemctl restart fixture", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.native.answerUi).toHaveBeenCalledWith("idle-grant-tool", { value: "Approve" }));
  finish({ requestId: "fixture", sessionId: "native-one", sessionFile: "/fixture/session", text: "完了" });
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
});


it("answers consultation through the mediator without opening or submitting to OhMyPi", async () => {
  const f = fixture();
  f.store.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "実行せず相談したい" });
  f.generate.mockResolvedValue(JSON.stringify({ action: "reply", answer: "設計の相談として答えます。実機は未確認です。" }));
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "WOLとMCPの使い分けは？");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled(); expect(f.localTurn).not.toHaveBeenCalled();
  const reply = f.store.messagesFor(f.bot.threadId).find(m => m.turnTerminal);
  expect(reply?.text).toContain("実機は未確認"); expect(reply?.nativeOmp).toBeUndefined();
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === source.id)?.requestPending).toBe(false);
  expect(f.generate.mock.calls[0]![2]).toContain("実行せず相談したい");
});

it("runs OMB management with the same input and settles only after the bounded handler returns", async () => {
  const f = fixture(); f.generate.mockResolvedValue(JSON.stringify({ action: "omb", note: "OMBの通知設定" }));
  let finish!: (value: string) => void;
  f.localTurn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const done = vi.fn();
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "OMBの定期実行を一覧で見せて", {}, undefined, done);
  await vi.waitFor(() => expect(f.localTurn).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled(); expect(f.settled).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  const local = f.localTurn.mock.calls[0]![0];
  expect(local.source.id).toBe(source.id); expect(local.text).toBe(source.text);
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.role === "user")).toHaveLength(1);
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.turnTerminal)).toBe(false);
  finish("OMB側の確認結果です。");
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.turnTerminal)?.text).toBe("OMB側の確認結果です。");
});

it("invalid route output never falls back to forwarding consultation", async () => {
  const f = fixture(); f.generate.mockResolvedValue("これは普通の相談です");
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "この構成について相談したい");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled(); expect(f.localTurn).not.toHaveBeenCalled();
});


it("submits uploaded image bytes to the existing native session and retains the original OMB attachment", async () => {
  const f = sharedFixture();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T1IAAAAASUVORK5CYII=", "base64");
  const image = saveImage(bytes, "image/png");
  const text = `この画像をPiの作業に使って\n\n<attached-image path="${image.path}" />`;
  const source = f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, text);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.native.submit).toHaveBeenCalledWith(source.id, "この画像をPiの作業に使って\n\n", [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === source.id)?.text).toBe(text);
  expect(f.generate.mock.calls[0]?.[4]?.[0]?.path).toBe(image.path);
});

it("image-only consultation can be answered without a native submission", async () => {
  const f = fixture();
  const image = saveImage(Buffer.from("fixture-image"), "image/png");
  f.generate.mockResolvedValue(JSON.stringify({ action: "reply", answer: "添付画面の意味を説明します。Piにはアクセスしていません。" }));
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, `<attached-image path="${image.path}" />`);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.open).not.toHaveBeenCalled(); expect(f.generate.mock.calls[0]?.[4]?.[0]?.path).toBe(image.path);
});

it("does not mark a human decision answered until the native host acknowledges it", async () => {
  const f = sharedFixture();
  let acknowledge!: () => void;
  Object.assign(f.native, { answerUi: vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; })) });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の受領確認テスト");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("question", { id: "receipt", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  const response = f.service.answer(f.bot.threadId, card.card!.requestId!, "deny");
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)?.card?.answered).toBeUndefined();
  acknowledge();
  expect(await response).toBe("rejected");
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)?.card?.answered).toBe("deny");
});

it("keeps a decision pending and explains a lost native receipt in Japanese", async () => {
  const f = sharedFixture();
  Object.assign(f.native, { answerUi: vi.fn(async () => { throw Error("synthetic receipt lost"); }) });
  f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, "架空の回答通信障害テスト");
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("question", { id: "lost-receipt", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  expect(await f.service.answer(f.bot.threadId, card.card!.requestId!, "allow")).toBe("unavailable");
  const messages = f.store.messagesFor(f.bot.threadId);
  expect(messages.find(m => m.id === card.id)?.card?.answered).toBeUndefined();
  expect(messages.find(m => m.id === card.id)?.card?.expired).not.toBe(true);
  expect(messages.some(m => m.text?.includes("Piへの回答の受領を確認できませんでした"))).toBe(true);
});

it("steers through the shared input, records admission once and retains the original turn", async () => {
  const f=sharedFixture();Object.assign(f.native,{canSteer:()=>true,requestStatus:()=>"accepted",steer:vi.fn(async()=>"steered")});
  vi.mocked(f.native.submit).mockImplementation(()=>new Promise(()=>{}));
  const binding=f.service.binding(f.bot.id,f.bot.threadId)!;
  const original=f.service.dispatch(binding,"元の処理");await vi.waitFor(()=>expect(f.native.submit).toHaveBeenCalledOnce());
  f.native.emit("nativeState",{busy:true,streaming:true});
  const source=await f.service.steer(binding,"追加指示",{sendId:"synthetic-steer-send-0001"});
  expect(source.steered).toBe(true);expect((f.native as any).steer).toHaveBeenCalledWith(source.id,"追加指示",[]);
  expect(f.native.submit).toHaveBeenCalledOnce();expect(f.native.stop).not.toHaveBeenCalled();
  f.native.emit("nativeEntry",{entryId:"steer-native",role:"user",text:"追加指示",own:true,activeOwn:true,snapshot:false,sessionId:"native-one"});
  const ledger=JSON.parse(readFileSync(join(f.dir,"native-omp-ledger.json"),"utf8"));
  expect(ledger[source.id]).toMatchObject({parentRequestId:original.id,admissionEntryId:"steer-native"});
  expect(f.store.messagesFor(f.bot.threadId).filter(m=>m.text==="追加指示")).toHaveLength(1);
});

it("records an idle native-bound steer as not sent after Luna judges it needs native execution", async () => {
  const f=sharedFixture(),binding=f.service.binding(f.bot.id,f.bot.threadId)!;
  const source=await f.service.steer(binding,"送らない");
  expect(source.requestCancelled).toBe(true);expect(source.steered).toBe(false);
  expect(f.generate).toHaveBeenCalledOnce();expect(f.native.submit).not.toHaveBeenCalled();
  expect(f.store.messagesFor(f.bot.threadId).some(m=>m.requestMessageId===source.id && m.turnSucceeded===false)).toBe(true);
});

it("separates reconnecting and queued state from actual working without draining uncertain work", async () => {
  const f=sharedFixture();f.service.dispatch(f.service.binding(f.bot.id,f.bot.threadId)!,"元の処理");
  await vi.waitFor(()=>expect(f.settled).toHaveBeenCalledOnce());f.settled.mockClear();
  f.native.emit("nativeState",{busy:true,reconnecting:true});
  expect(f.store.taskByThread(f.bot.id,f.bot.threadId)?.activity).toBe("no-signal");
  expect(f.service.status(f.bot.threadId)?.state).toBe("reconnecting");
  f.native.emit("nativeState",{busy:true,streaming:false,queued:2,waiting:false});
  expect(f.store.taskByThread(f.bot.id,f.bot.threadId)?.activity).toBe("no-signal");
  expect(f.service.status(f.bot.threadId)?.state).toBe("native-queued");expect(f.settled).not.toHaveBeenCalled();
  f.native.emit("nativeState",{busy:false,streaming:false,queued:0,waiting:false});
  expect(f.store.taskByThread(f.bot.id,f.bot.threadId)?.busy).toBe(false);expect(f.settled).toHaveBeenCalledOnce();
});

it("surfaces a recovered approval without request context instead of silently deadlocking mediator mode", async () => {
  const f=sharedFixture();f.service.close();Object.assign(f.native,{answerUi:vi.fn()});
  writeFileSync(join(f.dir,"native-omp.json"),JSON.stringify({bindings:[{...f.binding,connection:"shared-tui",approvalPolicy:"mediator"}]}),{mode:0o600});
  writeFileSync(join(f.dir,"native-omp-sessions.json"),JSON.stringify({[f.bot.threadId]:"native-one"}),{mode:0o600});
  vi.mocked(f.native.initialize).mockImplementation(async()=>{
    f.native.emit("nativeState",{busy:true,streaming:true,waiting:true});
    f.native.emit("question",{id:"unowned-recovered",method:"select",title:"Allow tool: bash\nCommand: mkfs.ext4 /dev/sda",options:["Approve","Deny"]});
    return {sessionId:"native-one",sessionFile:"/fixture/session",resumed:true,cancelled:false};
  });
  const service=f.create();service.start();
  await vi.waitFor(()=>expect(f.store.messagesFor(f.bot.threadId).some(m=>m.card?.requestType==="permission")).toBe(true));
  expect(f.store.taskByThread(f.bot.id,f.bot.threadId)?.activity).toBe("waiting-on-you");
  expect(f.native.answerUi).not.toHaveBeenCalled();expect(f.native.submit).not.toHaveBeenCalled();
  const card=f.store.messagesFor(f.bot.threadId).find(m=>m.card?.requestType==="permission")!;
  expect(card.card?.subtitle).toContain("元の依頼と操作の対応を確認できない");
  expect(await service.answer(f.bot.threadId,card.card!.requestId!,"deny")).toBe("rejected");
});

it("keeps an automatic approval with missing receipt visible rather than silently abandoning native input", async () => {
  const f=sharedFixture();f.service.close();Object.assign(f.native,{answerUi:vi.fn(async()=>{throw Error("missing receipt");})});
  writeFileSync(join(f.dir,"native-omp.json"),JSON.stringify({bindings:[{...f.binding,connection:"shared-tui",approvalPolicy:"mediator"}]}),{mode:0o600});
  const service=f.create(),source=service.dispatch(service.binding(f.bot.id,f.bot.threadId)!,"状態を調べて");
  await vi.waitFor(()=>expect(f.settled).toHaveBeenCalledOnce());
  f.native.emit("nativeEntry",{entryId:"approval-owner",role:"user",text:source.text,sessionId:"native-one",own:true,snapshot:false});
  f.generate.mockResolvedValue('{"highRisk":false}');
  f.native.emit("question",{id:"receipt-missing",method:"select",title:"Allow tool: bash\nCommand: lsblk",options:["Approve","Deny"]});
  await vi.waitFor(()=>expect(f.store.messagesFor(f.bot.threadId).some(m=>m.card?.subtitle?.includes("受領を確認できません"))).toBe(true));
  expect(f.native.answerUi).toHaveBeenCalledTimes(1);
  expect(f.store.messagesFor(f.bot.threadId).find(m=>m.card?.requestType==="permission")?.card?.answered).toBeUndefined();
});

async function runningSteerFixture(approvalPolicy?: "mediator") {
  const f=sharedFixture(approvalPolicy);let complete!: (value: any)=>void;
  Object.assign(f.native,{canSteer:vi.fn(()=>true),requestStatus:()=>"accepted",steer:vi.fn(async()=>"steered")});
  vi.mocked(f.native.submit).mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const binding=f.service.binding(f.bot.id,f.bot.threadId)!;
  const original=f.service.dispatch(binding,"実行中の元の依頼");
  await vi.waitFor(()=>expect(f.native.submit).toHaveBeenCalledOnce());
  f.native.emit("nativeState",{busy:true,streaming:true});
  return {...f,binding,original,complete:(text="元の結果")=>complete({requestId:original.id,sessionId:"native-one",sessionFile:"/fixture/session",text})};
}

it("answers a mid-turn consultation in Luna without touching the native job or its busy state",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValue(JSON.stringify({action:"reply",answer:"相談として説明します。"}));
  const source=await f.service.steer(f.binding,"それはどういう意味？");
  expect((f.native as any).steer).not.toHaveBeenCalled();expect(f.native.stop).not.toHaveBeenCalled();expect(f.native.close).not.toHaveBeenCalled();
  expect(f.store.taskByThread(f.bot.id,f.bot.threadId)?.busy).toBe(true);expect(f.settled).not.toHaveBeenCalled();
  expect(f.store.messagesFor(f.bot.threadId).find(m=>m.requestMessageId===source.id&&m.turnTerminal)?.text).toBe("相談として説明します。");
  const prompt=f.generate.mock.calls.at(-1)![2],data=JSON.parse(prompt.slice(prompt.lastIndexOf("\n")+1));
  expect(data.user_request).toBe("それはどういう意味？");expect(data.running_request).toBe("実行中の元の依頼");expect(data.delivery).toBe("steer");
});
it("runs OMB-only management locally while the original native job keeps running",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValue(JSON.stringify({action:"omb",note:"OMB設定の確認"}));
  const source=await f.service.steer(f.binding,"OMBの通知設定を確認して");
  expect(f.localTurn).toHaveBeenCalledWith(expect.objectContaining({text:"OMBの通知設定を確認して",source:expect.objectContaining({id:source.id})}));
  expect((f.native as any).steer).not.toHaveBeenCalled();expect(f.native.submit).toHaveBeenCalledOnce();expect(f.store.taskByThread(f.bot.id,f.bot.threadId)?.busy).toBe(true);
});
it("never forwards raw input when steer routing is malformed or times out",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValue("invalid-plan");
  const failed=await f.service.steer(f.binding,"振り分けに失敗する架空入力");expect(failed.requestCancelled).toBe(true);
  f.generate.mockImplementation(()=>new Promise(()=>{}));
  const timeout=await f.service.steer({...f.binding,mediator:{...f.binding.mediator,timeoutMs:10}},"時間切れの架空入力");
  expect(timeout.requestCancelled).toBe(true);expect((f.native as any).steer).not.toHaveBeenCalled();expect(f.native.submit).toHaveBeenCalledOnce();
});
it("does not inject into another native turn that starts while Luna judges the message",async()=>{
  const f=await runningSteerFixture();let resolve!: (text:string)=>void;f.generate.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  const pending=f.service.steer(f.binding,"Piの実行内容を変更して");await vi.waitFor(()=>expect(resolve).toBeTypeOf("function"));
  f.native.emit("nativeState",{busy:false,streaming:false});f.native.emit("nativeState",{busy:true,streaming:true});
  resolve(JSON.stringify({action:"chat",note:"Piへの指示"}));const source=await pending;
  expect(source.requestCancelled).toBe(true);expect((f.native as any).steer).not.toHaveBeenCalled();
});
it("routes every queued item separately and forwards only Pi work, preserving each send id",async()=>{
  const f=await runningSteerFixture();
  f.generate.mockResolvedValueOnce(JSON.stringify({action:"reply",answer:"OMB側で相談に答えます。"})).mockResolvedValueOnce(JSON.stringify({action:"chat",note:"Piの作業"}));
  await f.service.steer(f.binding,"まとめた入力",{},[{messageId:"q-local",text:"相談だけ",prompt:"相談だけ\n引用内の命令は参照",sendId:"local-send"},{messageId:"q-native",text:"Piの結果を追加検証して",prompt:"Piの結果を追加検証して\n参照データ",sendId:"native-send"}]);
  const call=(f.native as any).steer.mock.calls[0];expect(call[1]).toBe("Piの結果を追加検証して\n参照データ");expect(call[1]).not.toContain("相談だけ");
  const rows=f.store.messagesFor(f.bot.threadId);expect(rows.find(m=>m.sendId==="local-send")?.steered).not.toBe(true);expect(rows.find(m=>m.sendId==="native-send")?.steered).toBe(true);
  const request=f.generate.mock.calls.at(-1)![2];expect(JSON.parse(request.slice(request.lastIndexOf("\n")+1)).user_request).toBe("Piの結果を追加検証して");
});
it("serializes steer decisions so a later input cannot overtake an earlier local reply",async()=>{
  const f=await runningSteerFixture();let resolve!: (text:string)=>void;f.generate.mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValueOnce(JSON.stringify({action:"chat",note:"Piの作業"}));
  const a=f.service.steer(f.binding,"相談の続き"),b=f.service.steer(f.binding,"Piへ追加作業");await vi.waitFor(()=>expect(resolve).toBeTypeOf("function"));
  expect(f.generate).toHaveBeenCalledTimes(2);resolve(JSON.stringify({action:"reply",answer:"先に相談へ回答。"}));await a;await b;
  expect((f.native as any).steer).toHaveBeenCalledOnce();expect((f.native as any).steer.mock.calls[0][1]).toBe("Piへ追加作業");
});
it("applies explicit display instructions only to the local final answer, preserving the native original",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValueOnce(JSON.stringify({action:"reply",answer:"今回の表示指示として受け付けました。",presentation:"箇条書きで表示して"}));
  await f.service.steer(f.binding,"箇条書きで表示して");expect((f.native as any).steer).not.toHaveBeenCalled();
  f.native.emit("nativeState",{busy:false,streaming:false});f.complete("加工しない元の回答");
  await vi.waitFor(()=>expect(f.formatter).toHaveBeenCalledWith(expect.objectContaining({answer:"加工しない元の回答",displayInstructions:"箇条書きで表示して"})));
  const final=f.store.messagesFor(f.bot.threadId).find(m=>m.requestMessageId===f.original.id&&m.nativeOmp);
  expect(final?.nativeOmp?.originalText).toBe("加工しない元の回答");
});
it("rejects model-invented display instructions rather than using or forwarding them",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValue(JSON.stringify({action:"reply",answer:"設定しました",presentation:"原文にはない指示"}));
  const source=await f.service.steer(f.binding,"短く答えて");expect(source.requestCancelled).toBe(true);expect(f.formatter).not.toHaveBeenCalled();expect((f.native as any).steer).not.toHaveBeenCalled();
});
it("cancels an unresponsive steer router without ever forwarding its late decision",async()=>{
  const f=await runningSteerFixture();let finish!:(value:string)=>void;f.generate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.service.steer(f.binding,"Piの追加確認");await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
  await f.service.stop(f.bot.threadId);const row=await pending;finish(JSON.stringify({action:"chat"}));await Promise.resolve();
  expect(row.requestCancelled).toBe(true);expect((f.native as any).steer).not.toHaveBeenCalled();
});
it("finishes a cancelled local steer even when the local handler ignores its signal",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValueOnce(JSON.stringify({action:"omb"}));f.localTurn.mockImplementationOnce(()=>new Promise(()=>{}));
  const pending=f.service.steer(f.binding,"OMBの設定を確認して");await vi.waitFor(()=>expect(f.localTurn).toHaveBeenCalledOnce());
  await f.service.stop(f.bot.threadId);expect((await pending).requestCancelled).toBe(true);expect((f.native as any).steer).not.toHaveBeenCalled();
});
it("does not fall through to Pi when an OMB handler fails or the shared connection closes during routing",async()=>{
  const f=await runningSteerFixture();f.generate.mockResolvedValueOnce(JSON.stringify({action:"omb"}));f.localTurn.mockRejectedValueOnce(Error("fixture failed"));
  expect((await f.service.steer(f.binding,"OMB設定" )).requestCancelled).toBe(true);
  let finish!:(value:string)=>void;f.generate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.service.steer(f.binding,"Piで追加確認");await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));f.native.emit("disconnected");finish(JSON.stringify({action:"chat"}));
  expect((await pending).requestCancelled).toBe(true);expect((f.native as any).steer).not.toHaveBeenCalled();
});
it("keeps explicit owner consent for the original request after a local consultation",async()=>{
  const f=await runningSteerFixture("mediator");Object.assign(f.native,{answerUi:vi.fn(async()=>{}),pendingOperation:()=>({id:"original-command",name:"bash",arguments:{command:"sudo systemctl restart fixture"}})});
  f.native.emit("nativeEntry",{entryId:"running-original",role:"user",text:f.original.text,sessionId:"native-one",own:true,snapshot:false});
  f.service.ownerConsent(f.bot.id,f.bot.threadId,"すべて許可");
  f.generate.mockResolvedValueOnce(JSON.stringify({action:"reply",answer:"相談への回答です。"}));await f.service.steer(f.binding,"相談だけです");
  f.generate.mockResolvedValue(JSON.stringify({highRisk:true,reason:"架空のサービス再起動"}));
  f.native.emit("question",{id:"original-high-risk",method:"select",title:"Allow tool: bash\nCommand: sudo systemctl restart fixture",options:["Approve","Deny"]});
  await vi.waitFor(()=>expect((f.native as any).answerUi).toHaveBeenCalledWith("original-high-risk",{value:"Approve"}));
  expect((f.native as any).steer).not.toHaveBeenCalled();
});
it("does not let an older formatter overwrite a late local display instruction",async()=>{
  const f=await runningSteerFixture();let old!:(value:string)=>void;
  f.formatter.mockImplementationOnce(()=>new Promise(resolve=>{old=resolve;})).mockResolvedValueOnce("新しい箇条書き表示");
  let decide!:(value:string)=>void;f.generate.mockImplementationOnce(()=>new Promise(resolve=>{decide=resolve;}));
  const pending=f.service.steer(f.binding,"箇条書きで表示して");await vi.waitFor(()=>expect(decide).toBeTypeOf("function"));
  const withFormatter={...f.binding,formatter:f.binding.mediator};
  f.complete("加工しない元の回答");await vi.waitFor(()=>expect(f.settled).toHaveBeenCalledOnce());
  const reply=f.store.messagesFor(f.bot.threadId).find(m=>m.requestMessageId===f.original.id&&m.nativeOmp)!;
  (f.service as any).formatReply(withFormatter,"元の依頼",reply);
  await vi.waitFor(()=>expect(old).toBeTypeOf("function"));decide(JSON.stringify({action:"reply",answer:"表示方法を受け付けました",presentation:"箇条書きで表示して"}));await pending;
  await vi.waitFor(()=>expect(f.store.messagesFor(f.bot.threadId).find(m=>m.id===reply.id)?.text).toBe("新しい箇条書き表示"));
  old("古い短縮表示");await Promise.resolve();await Promise.resolve();
  expect(f.store.messagesFor(f.bot.threadId).find(m=>m.id===reply.id)?.text).toBe("新しい箇条書き表示");expect(reply.nativeOmp?.originalText).toBe("加工しない元の回答");
});

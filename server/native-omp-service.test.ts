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
  const generate = vi.fn(async () => "架空の整理メモ");
  const open = vi.fn((_binding: OmpDestination) => {
    const client = new EventEmitter();
    return Object.assign(client, { initialize: vi.fn(async () => ({ sessionId: "native-one", sessionFile: "/fixture/session", resumed: true })),
      submit: vi.fn(async (requestId: string) => ({ requestId, sessionId: "native-one", sessionFile: "/fixture/session", text: "架空の回答" })),
      stop: vi.fn(async () => true), close: vi.fn() }) as unknown as NativeOmpTransport;
  });
  const settled = vi.fn();
  const create = () => {
    const service = new NativeOmpService({ dir, store, generate, open, sharedOpen: binding => NativeOmpCollab.connect(binding, { timeoutMs: 90000 }), formatter: { format: async () => "短い回答" }, settled });
    services.push(service); return service;
  };
  const service = create();
  return { dir, bot, store, generate, open, settled, create, service, binding };
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
  expect(() => f.service.dispatch(f.service.binding(f.bot.id, f.bot.threadId)!, '<attached-file path="/private/file" />')).toThrow(/plain text/);
  expect(f.generate).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});

function sharedFixture() {
  const f = fixture(); f.service.close();
  const native = f.open({} as OmpDestination);
  vi.spyOn(NativeOmpCollab, "connect").mockReturnValue(native as NativeOmpCollab);
  writeFileSync(join(f.dir, "native-omp.json"), JSON.stringify({ bindings: [{ ...f.binding, connection: "shared-tui" }] }), { mode: 0o600 });
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

it("mediator allows a low-risk native inspection once without an owner card", async () => {
  const f = reviewingFixture();
  await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledOnce());
  f.generate.mockResolvedValue('{"decision":"allow","importance":"low"}');
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
  f.generate.mockResolvedValue('{"decision":"allow","importance":"low"}');
  f.client.emit("question", { id: "format", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: mkfs.ext4 /dev/sda", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
  expect(f.client.answerUi).not.toHaveBeenCalled();
  expect(f.generate).toHaveBeenCalledTimes(1);
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.requestType === "permission")!;
  expect(f.service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
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
  finishReview('{"decision":"allow","importance":"low"}');
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
  expect(f.service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
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
  expect(f.service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
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
  expect(service.answer(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected");
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
  expect(f.service.answer(f.bot.threadId, card.requestId!, "allow")).toBe("unavailable");
  expect(f.service.answer(f.bot.threadId, card.requestId!, "answer", formatQuestionAnswers(card.questionRequest!.questions, [["次"]]))).toBe("answered");
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
  f.generate.mockResolvedValue('{"decision":"allow","importance":"low"}');
  f.native.emit("question", { id: "inspection-after-failure", method: "select", title: "Allow tool: bash\nCommand: lsblk", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.native.answerUi).toHaveBeenCalledWith("inspection-after-failure", { value: "Approve" }));
  f.native.emit("nativeEntry", { entryId: "human", role: "user", text: "人間から別の作業", sessionId: "native-one", own: false, activeOwn: false, snapshot: false });
  f.native.emit("question", { id: "human-inspection", method: "select", title: "Allow tool: bash\nCommand: lsblk", options: ["Approve", "Deny"] });
  await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.requestType === "permission")).toBe(true));
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

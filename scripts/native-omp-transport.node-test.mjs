import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { NativeOmpTransport, nativeOmpCommand } from "./native-omp-transport.mjs";

const binding = { host: "fixture.tailnet.test", user: "fixture", botId: "bot-a", threadId: "thread-a", binary: "/home/fixture/.local/bin/omp", stateRoot: "/home/fixture/.local/state/omb-native" };

function fixture(t, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.sent = []; child.killed = false;
  const sessionDir = nativeOmpCommand(binding).sessionDir;
  const session = { sessionFile: `${sessionDir}/session.jsonl`, sessionId: "native-a", resumed: true, cancelled: false };
  child.stdin = new Writable({ write(data, _encoding, done) {
    const frame = JSON.parse(data.toString());
    child.sent.push(frame);
    if (["negotiate_protocol", "open_session"].includes(frame.type)) queueMicrotask(() => output({ type: "response", id: frame.id, command: frame.type, success: true, data: frame.type === "open_session" ? session : {} }));
    done();
  } });
  child.kill = () => { child.killed = true; };
  const client = new NativeOmpTransport(child, sessionDir, { timeoutMs: 500, turnTimeoutMs: 500, ...options });
  const output = frame => child.stdout.write(JSON.stringify(frame) + "\n");
  const ready = () => output({ type: "ready", supportedProtocolVersions: [1, 2] });
  const initialize = async () => { ready(); return client.initialize(); };
  const message = text => output({ type: "message_end", messageId: text, message: { role: "assistant", content: [{ type: "thinking", thinking: "not displayed" }, { type: "text", text }] } });
  const finish = (id, sessionSettled = true) => output({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled });
  t.after(() => client.close());
  return { client, child, output, initialize, message, finish, session };
}

test("SSH uses a fixed user/host, strict host keys and no agent forwarding", () => {
  const result = nativeOmpCommand(binding);
  assert.equal(result.command, "/usr/bin/ssh");
  for (const value of ["StrictHostKeyChecking=yes", "BatchMode=yes", "ForwardAgent=no", "ClearAllForwardings=yes"]) assert.ok(result.args.includes(value));
  assert.equal(result.args.at(-2), "fixture@fixture.tailnet.test");
  assert.ok(result.args.at(-1).endsWith("' --continue"));
  assert.ok(!result.args.includes("--no-session"));
});

test("each source bot/thread has a stable separate native session directory", () => {
  assert.deepEqual(nativeOmpCommand(binding), nativeOmpCommand({ ...binding }));
  assert.notEqual(nativeOmpCommand(binding).sessionDir, nativeOmpCommand({ ...binding, threadId: "thread-b" }).sessionDir);
  assert.notEqual(nativeOmpCommand(binding).sessionDir, nativeOmpCommand({ ...binding, botId: "bot-b" }).sessionDir);
});

test("destination/path injection and missing source IDs are refused", () => {
  for (const bad of [{ host: "-oProxyCommand=bad" }, { user: "root;bad" }, { binary: "/bin/omp;bad" }, { stateRoot: "/home/../etc" }, { botId: "" }]) assert.throws(() => nativeOmpCommand({ ...binding, ...bad }));
});

test("initialization negotiates v2 and opens only the pinned persistent conversation", async t => {
  const f = fixture(t);
  assert.equal((await f.initialize()).sessionId, "native-a");
  assert.deepEqual(f.child.sent.map(item => item.type), ["negotiate_protocol", "open_session"]);
  assert.equal(f.child.sent[1].sessionDir, nativeOmpCommand(binding).sessionDir);
});

test("a returned session outside the pinned directory closes the connection", async t => {
  const f = fixture(t); f.session.sessionFile = "/different/thread.jsonl";
  await assert.rejects(f.initialize(), /pinned session/u);
  assert.equal(f.child.killed, true);
  assert.ok(!f.child.sent.some(frame => frame.type === "prompt"));
});

test("unsupported protocol cannot fall back to lossy v1", async t => {
  const f = fixture(t);
  f.output({ type: "ready", supportedProtocolVersions: [1] });
  await assert.rejects(f.client.initialize(), /v2 required/u);
  assert.equal(f.child.killed, true);
});

test("native prompt contains the exact user request, without Bot system instructions", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "架空のサービスの状態を確認してください。");
  assert.deepEqual(f.child.sent.at(-1), { id: "req-a", type: "prompt", message: "架空のサービスの状態を確認してください。" });
  f.message("確認結果です。"); f.finish("req-a");
  assert.equal((await answer).text, "確認結果です。");
});

test("an accepted prompt and agent_end alone do not prove successful completion", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic request");
  let completed = false; void answer.then(() => { completed = true; });
  f.message("yielded");
  f.output({ type: "response", id: "req-a", command: "prompt", success: true });
  f.output({ type: "agent_end", isTerminal: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  f.finish("req-a", false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  f.message("background result"); f.output({ type: "session_settled" });
  assert.equal((await answer).text, "yielded\n\nbackground result");
});

test("completed requests deduplicate and conflicting retries cannot send another prompt", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.message("ok"); f.finish("req-a");
  assert.deepEqual(await answer, await f.client.submit("req-a", "synthetic"));
  await assert.rejects(f.client.submit("req-a", "different"), /reused/u);
  assert.equal(f.child.sent.filter(item => item.type === "prompt").length, 1);
});

test("concurrent native prompts are refused rather than mixed", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  await assert.rejects(f.client.submit("req-b", "other"), /busy/u);
  f.message("ok"); f.finish("req-a"); await answer;
});

test("provider failure cannot be presented as a successful answer or retried automatically", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.message("partial"); f.output({ type: "prompt_result", id: "req-a", status: "error", sessionSettled: true });
  await assert.rejects(answer, /error/u);
  await assert.rejects(f.client.submit("req-a", "synthetic"));
  assert.equal(f.child.sent.filter(item => item.type === "prompt").length, 1);
});

test("SSH disconnect after submission is indeterminate and never resends", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.child.emit("close", 255);
  await assert.rejects(answer, /do not resend/u);
  await assert.rejects(f.client.submit("req-b", "synthetic"));
  assert.equal(f.child.sent.filter(item => item.type === "prompt").length, 1);
});

test("unhandled native approval fails closed without sending an allow response", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.output({ type: "extension_ui_request", id: "approval-a", method: "confirm", message: "synthetic approval" });
  await assert.rejects(answer, /human approval/u);
  assert.ok(!f.child.sent.some(item => item.type === "extension_ui_response"));
});

test("human question responses must match an active request and exact option", async t => {
  const f = fixture(t); await f.initialize();
  f.client.on("question", () => {});
  f.output({ type: "extension_ui_request", id: "approval-a", method: "select", options: ["Deny", "Allow once"] });
  assert.throws(() => f.client.answerUi("missing", { value: "Allow once" }));
  assert.throws(() => f.client.answerUi("approval-a", { value: "Always allow" }));
  f.client.answerUi("approval-a", { value: "Deny" });
  assert.deepEqual(f.child.sent.at(-1), { type: "extension_ui_response", id: "approval-a", value: "Deny" });
  assert.throws(() => f.client.answerUi("approval-a", { value: "Allow once" }));
});

test("expired approvals cannot be answered", async t => {
  const f = fixture(t); await f.initialize(); f.client.on("question", () => {});
  f.output({ type: "extension_ui_request", id: "approval-a", method: "confirm" });
  f.output({ type: "extension_ui_request", method: "cancel", targetId: "approval-a" });
  assert.throws(() => f.client.answerUi("approval-a", { confirmed: true }));
});

test("remote requests cannot execute host tools on the Mac", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.output({ type: "host_tool_call", id: "bad-tool", toolName: "bash" });
  await assert.rejects(answer, /Invalid OhMyPi transport/u);
  assert.ok(!f.child.sent.some(item => item.type === "host_tool_result"));
});

test("large chunked replies preserve Japanese UTF-8 text", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  const text = "架空".repeat(100_000);
  const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }));
  const count = Math.ceil(bytes.length / 200_000);
  for (let index = 0; index < count; index++) f.output({ type: "rpc_chunk", chunkId: "chunk-a", index, count, byteLength: bytes.length, data: bytes.subarray(index * 200_000, (index + 1) * 200_000).toString("base64") });
  f.finish("req-a"); assert.equal((await answer).text, text);
});

test("interrupted chunk sequences close rather than show truncated results", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.output({ type: "rpc_chunk", chunkId: "chunk-a", index: 0, count: 2, byteLength: 10, data: Buffer.from("hello").toString("base64") });
  f.output({ type: "session_settled" });
  await assert.rejects(answer, /Invalid OhMyPi transport/u);
});

test("turn timeout closes the connection instead of falling back", async t => {
  const f = fixture(t, { turnTimeoutMs: 20 }); await f.initialize();
  await assert.rejects(f.client.submit("req-a", "synthetic"), /timed out/u);
  assert.equal(f.child.killed, true);
});

test("Stop sends native abort without starting another prompt", async t => {
  const f = fixture(t); await f.initialize();
  const answer = f.client.submit("req-a", "synthetic");
  f.client.stop(); assert.equal(f.child.sent.at(-1).type, "abort");
  f.output({ type: "prompt_result", id: "req-a", status: "aborted" });
  await assert.rejects(answer, /aborted/u);
});

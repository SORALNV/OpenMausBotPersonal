import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationServerEnvironment } from "./control-omb.ts";
import { request, handleToolCall } from "./mcp-server.ts";

const repo = process.cwd();
const root = mkdtempSync(join(tmpdir(), "omb-omp-fixture-")), data = join(root, "data"), native = join(root, "native");
mkdirSync(data); mkdirSync(native); mkdirSync(join(data, "tmp"));
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(repo, "server/testing/fake-claude-cli.ts") } } }, decider: { enabled: false }, newBotDefaults: { profile: { computer: "off", browser: false } } }));
const mediator = join(repo, "server/testing/fake-native-omp-mediator.mjs"); chmodSync(mediator, 0o755);
const env = { ...verificationServerEnvironment({}, data, port), OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off", OMB_NATIVE_CODEX_CLI: mediator, OMB_NATIVE_CODEX_HOME: native, FAKE_CLAUDE_OMP_ROOT: native };
const child = spawn(process.execPath, ["--import", join(repo, "server/testing/native-omp-fixture.mjs"), join(repo, "server/index.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
const url = `http://127.0.0.1:${port}`;
const api = (path, options) => request(path, options?.body && typeof options.body !== "string" ? { ...options, body: JSON.stringify(options.body) } : options, url);
const tool = (name, args) => handleToolCall(name, args, api);
const calls = () => existsSync(join(native, "calls.jsonl")) ? readFileSync(join(native, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
const until = async (read, accept) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read(); if (accept(value)) return value;
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("Native OhMyPi fixture did not settle");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const reportDir = join(repo, ".privacy-dev/raspberrypi-native-connect"); mkdirSync(reportDir, { recursive: true });
try {
  await until(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, Boolean);
  const { bot } = await tool("create_bot", { name: "Synthetic RaspberryPi" });
  const threadId = bot.activeTaskId;
  const selection = { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 10_000 };
  const binding = { botId: bot.id, enabled: true, host: "fixture.tailnet.test", user: "fixture", binary: "/fixture/omp", stateRoot: "/fixture/threads", profile: "omb-native", cwd: "/fixture/workspace", model: "openai-codex/fixture", mediator: selection, formatter: selection };
  await api("/api/native-omp", { method: "PUT", body: { bindings: [binding] } });
  const messages = (thread = threadId) => api(`/api/threads/${thread}/messages?limit=150`);
  const send = text => tool("send_bot_message", { bot_id: bot.id, task_id: threadId, text });
  const terminalCount = async () => (await messages()).messages.filter(message => message.turnTerminal).length;
  const settled = count => until(messages, value => value.messages.filter(message => message.nativeOmp?.formatted).length >= count);
  await send("架空の依頼A"); await settled(1);
  const first = (await messages()).messages.find(message => message.nativeOmp);
  assert.equal(first.text, "短縮した架空の回答");
  assert.ok(first.nativeOmp.originalText.includes('"user_request":"架空の依頼A"'));
  assert.ok(first.nativeOmp.originalText.includes('"mediator_note":"短縮した架空の回答"'));
  await send("架空の依頼B"); await settled(2);
  assert.equal(new Set((await messages()).messages.filter(message => message.nativeOmp).map(message => message.nativeOmp.sessionId)).size, 1);
  assert.equal(calls().filter(call => call.type === "prompt").length, 2);
  assert.ok(calls().filter(call => call.type === "prompt").every(call => !call.message.includes("架空の元回答:")));

  await send("SYNTHETIC_APPROVAL");
  const approvalState = await until(messages, value => value.messages.some(message => message.card?.requestType === "permission" && !message.card.answered));
  const approval = approvalState.messages.find(message => message.card?.requestType === "permission" && !message.card.answered);
  assert.equal(existsSync(join(native, "approved-marker")), false);
  assert.equal(calls().filter(call => call.type === "extension_ui_response").length, 0);
  for (const text of ["Queued fixture A", "Queued fixture B"]) {
    const queued = await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: { threadId, text, delivery: "queue" } });
    assert.equal(queued.queued, true);
  }
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: approval.card.requestId, behavior: "allow" } });
  await settled(5); assert.equal(existsSync(join(native, "approved-marker")), true);
  assert.equal(calls().filter(call => call.type === "extension_ui_response" && call.confirmed).length, 1);
  assert.equal((await messages()).messages.filter(message => message.role === "user" && message.text === "Queued fixture A").length, 1);

  await send("SYNTHETIC_QUESTION");
  const questionState = await until(messages, value => value.messages.some(message => message.card?.requestType === "question" && !message.card.answered));
  const question = questionState.messages.find(message => message.card?.requestType === "question" && !message.card.answered);
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: question.card.requestId, behavior: "answer", message: "Beta" } });
  await settled(6); assert.ok(calls().some(call => call.type === "extension_ui_response" && call.value === "Beta"));

  await send("SYNTHETIC_SELECT_APPROVAL");
  const selectState = await until(messages, value => value.messages.some(message => message.card?.requestType === "permission" && !message.card.answered && !message.card.expired));
  const select = selectState.messages.find(message => message.card?.requestType === "permission" && !message.card.answered && !message.card.expired);
  assert.deepEqual(select.card.options, ["Allow", "Deny"]);
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: select.card.requestId, behavior: "allow" } });
  await settled(7); assert.ok(calls().some(call => call.type === "extension_ui_response" && call.value === "Approve"));
  assert.ok(!calls().some(call => call.value === "Approve write for this session"));

  const before = await terminalCount();
  await send("SYNTHETIC_FAILURE"); await until(terminalCount, value => value === before + 1);
  const failed = (await messages()).messages.filter(message => message.turnTerminal).at(-1);
  assert.equal(failed.turnSucceeded, false);
  assert.ok(Object.values(JSON.parse(readFileSync(join(data, "private/native-omp-ledger.json"), "utf8"))).some(receipt => receipt.stage === "indeterminate"));

  const secondThread = (await api(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title: "Separate native fixture" } })).task.threadId;
  await tool("send_bot_message", { bot_id: bot.id, task_id: secondThread, text: "Separate synthetic session" });
  const secondState = await until(() => messages(secondThread), value => value.messages.some(message => message.nativeOmp?.formatted));
  assert.notEqual(secondState.messages.find(message => message.nativeOmp).nativeOmp.sessionId, first.nativeOmp.sessionId);

  const beforeStop = await terminalCount();
  await send("SYNTHETIC_HOLD");
  await until(async () => calls(), value => value.some(call => call.type === "prompt" && call.message?.includes("SYNTHETIC_HOLD")));
  await api(`/api/bots/${bot.id}/interrupt`, { method: "POST", body: { threadId } });
  await until(terminalCount, value => value === beforeStop + 1);
  assert.ok(calls().some(call => call.type === "abort"));

  const { bot: other } = await tool("create_bot", { name: "Synthetic unrelated" });
  const previousNativePrompts = calls().filter(call => call.type === "prompt").length;
  await tool("send_bot_message", { bot_id: other.id, text: "Other fixture only" });
  await until(() => api(`/api/threads/${other.activeTaskId}/messages?limit=100`), value => value.messages.some(message => message.role === "bot" && message.kind === "text"));
  assert.equal(calls().filter(call => call.type === "prompt").length, previousNativePrompts);
  const { bot: shared } = await tool("create_bot", { name: "Synthetic shared TUI" });
  const sharedBinding = { ...binding, botId: shared.id, connection: "shared-tui" };
  await api("/api/native-omp", { method: "PUT", body: { bindings: [binding, sharedBinding] } });
  for (const text of ["そのまま送る共有入力A", "そのまま送る共有入力B"]) {
    await tool("send_bot_message", { bot_id: shared.id, task_id: shared.activeTaskId, text });
    await until(() => api(`/api/threads/${shared.activeTaskId}/messages?limit=100`), value => value.messages.some(message => message.nativeOmp?.originalText === "架空の元回答: " + text && message.nativeOmp?.formatted));
  }
  const sharedCalls = calls().filter(call => call.type === "prompt" && call.message?.startsWith("そのまま送る共有入力"));
  assert.deepEqual(sharedCalls.map(call => call.message), ["そのまま送る共有入力A", "そのまま送る共有入力B"]);
  const beforeReview = (await messages()).messages.filter(m => m.nativeOmp?.formatted).length;
  await api("/api/native-omp", { method: "PUT", body: { bindings: [{ ...binding, approvalPolicy: "mediator" }, sharedBinding] } });
  const cardsBefore = (await messages()).messages.filter(m => m.card?.requestType === "permission").length;
  await send("SYNTHETIC_REVIEW_INSPECTION"); await settled(beforeReview + 1);
  assert.equal((await messages()).messages.filter(m => m.card?.requestType === "permission").length, cardsBefore);
  assert.ok((await messages()).messages.some(m => m.kind === "activity" && m.text?.includes("Lunaが低リスク操作")));
  const responseCount = calls().filter(c => c.type === "extension_ui_response").length;
  await send("SYNTHETIC_REVIEW_IMPORTANT");
  const importantState = await until(messages, value => value.messages.some(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired));
  assert.equal(calls().filter(c => c.type === "extension_ui_response").length, responseCount);
  const important = importantState.messages.find(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired);
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: important.card.requestId, behavior: "deny" } });
  await settled(beforeReview + 2);
  const report = { ok: true, isolatedHome: true, syntheticNativePeer: true, independentMediator: true, originalInputPreserved: true, nativeAnswerPreserved: true, shortDisplayOnly: true,
    nativeSessionResumed: true, separateNativeSessionPerThread: true, queuedInputsSeparate: true, humanApprovalBeforeTool: true, nativeSelectApprovalOnceOnly: true, humanQuestionsRelayed: true, nativeStopDispatched: true, nativeFailureNotSuccess: true, unrelatedBotUnchanged: true, sharedConnectorExactText: true, sharedConnectorRepeatedTurns: true, mediatorInspectionApproval: true, importantOperationStillNeedsHuman: true, testedAt: new Date().toISOString() };
  writeFileSync(join(reportDir, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
} catch (error) {
  writeFileSync(join(reportDir, "fixture-error.log"), logs, { mode: 0o600 });
  try {
    const state = await api("/api/native-omp");
    const bots = await api("/api/bots?messages=0");
    const history = await Promise.all(bots.bots.map(bot => api(`/api/threads/${bot.activeTaskId}/messages?limit=50`)));
    writeFileSync(join(reportDir, "fixture-error.json"), JSON.stringify({ state, history, calls: calls() }, null, 2), { mode: 0o600 });
  } catch { /* A crashed fixture may not answer diagnostics. */ }
  throw error;
} finally {
  const exited = once(child, "exit"); if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
  rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request, handleToolCall } from "./mcp-server.ts";

const entry = process.argv[2];
if (!entry?.includes("/.privacy-dev/personal-build/") || !entry.endsWith("/Contents/Resources/server/index.js")) throw Error("Select a staged app server");
const root = await mkdtemp(join(tmpdir(), "omb-chat-connection-"));
const data = join(root, "data"), home = join(root, "home");
await mkdir(data); await mkdir(home);
const token = "synthetic-local-connection-token-000000000";
const ownerToken = process.argv.includes("--ui") ? "d".repeat(43) : undefined;
const ownerHeaders = ownerToken ? { "x-openmausbot-desktop-owner": ownerToken } : {};
let health = "LOGIN_REQUIRED", reads = 0, modelCalls = 0, loseLogin = false;
const events = [];
let modelAnswer = '{"kind":"ignore"}';
const modelInputs = [];
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const bridge = createServer(async (req, res) => {
  if (req.url === "/v1/models") return json(res, { data: [{ id: "fixture" }] });
  if (req.url.startsWith("/v1/")) {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body); modelInputs.push(input); modelCalls++;
    assert(!input.tools?.length, "Notification judge received action tools");
    return json(res, { id: "fixture", model: "fixture", choices: [{ message: { role: "assistant", content: modelAnswer }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
  if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
  if (req.url.startsWith("/local/changes")) {
    const after = new URL(req.url, "http://127.0.0.1").searchParams.get("after");
    return json(res, { cursor: events.at(-1)?.seq ?? 0, changes: after === null ? [] : events.filter(event => event.seq > Number(after)), status: health });
  }
  let text = ""; for await (const part of req) text += part;
  const rpc = JSON.parse(text);
  assert.equal(rpc.params?.name, "get_monitored_thread"); assert.equal(req.headers["x-gchat-read-only"], "true"); reads++;
  if (loseLogin) health = "LOGIN_REQUIRED";
  const result = { messages: [{ sender: { name: "架空の試験者" }, text: "架空の試験用本文です。" }] };
  json(res, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } } });
});
const bridgePort = await listen(bridge);
const reservation = createServer(); const port = await listen(reservation); await new Promise(done => reservation.close(done));
assert.notEqual(port, 8897);
await writeFile(join(data, "config.json"), JSON.stringify({ instances: { fixture: { driver: "openai-compat", config: { url: `http://127.0.0.1:${bridgePort}/v1`, key: "synthetic-only", model: "fixture", tools: true } } }, decider: { enabled: false }, onboarding: { completedAt: "2026-10-30T00:00:00Z", version: 1, reelSeen: true, hintsSeen: ["onboarding-cloud-v1"] } }), { mode: 0o600 });
let logs = "";
const start = () => {
  const args = [...(ownerToken ? ["--import", fileURLToPath(new URL("../server/testing/desktop-parent.mjs", import.meta.url))] : []), entry];
  const processChild = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off", OMB_DATA_DIR: data, OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0", OMB_PRIVACY_PYTHON: "/usr/bin/python3", OMB_PRIVACY_WORKER: fileURLToPath(new URL("./testing/fake-chat-connection-detector.py", import.meta.url)), OMB_PRIVACY_CHECKPOINT: root, ...(ownerToken ? { OMB_STATIC_DIR: resolve(dirname(entry), "../ui"), OMB_DESKTOP_PARENT: "1", OMB_TEST_DESKTOP_OWNER_TOKEN: ownerToken } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  processChild.stdout.on("data", part => { logs += part; }); processChild.stderr.on("data", part => { logs += part; }); return processChild;
};
let child = start();
const base = `http://127.0.0.1:${port}`;
const api = (path, options = {}) => request(path, { ...options, headers: { ...ownerHeaders, ...options.headers }, ...(options.body && typeof options.body !== "string" ? { body: JSON.stringify(options.body) } : {}) }, base);
const rawCheck = () => fetch(base + "/api/google-chat/check", { method: "POST", headers: { "content-type": "application/json", ...ownerHeaders }, body: "{}", signal: AbortSignal.timeout(15000) });
const until = async check => {
  const end = Date.now() + 20000;
  while (!await check()) { if (Date.now() > end) throw Error("Notification fixture did not reach expected state"); await new Promise(done => setTimeout(done, 100)); }
};
try {
  const end = Date.now() + 45000;
  while (!(await fetch(base + "/api/health").then(r => r.ok).catch(() => false))) {
    if (Date.now() > end || child.exitCode !== null) throw Error("Isolated server startup failed");
    await new Promise(done => setTimeout(done, 100));
  }
  const { bot } = await handleToolCall("create_bot", { name: "Synthetic connection check", instance_id: "fixture", model: "fixture" }, api);
  const config = { enabled: true, url: `http://127.0.0.1:${bridgePort}/mcp`, token, botId: bot.id, threadId: bot.activeTaskId };
  const authState = await api("/api/auth/session", { signal: AbortSignal.timeout(3000) });
  assert(authState && typeof authState === "object", "Unrelated authentication route did not respond");
  const absent = await fetch(base + "/api/synthetic-route-that-does-not-exist", { headers: ownerHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal(absent.status, 404);
  for (let n = 0; n < 2; n++) {
    const saved = await api("/api/google-chat", { method: "PUT", body: config });
    assert.equal(saved.state, "LOGIN_REQUIRED"); assert.equal(saved.registered, true); assert.equal(saved.monitorReady, false);
  }
  const failed = await rawCheck(); assert.equal(failed.status, 400); assert.equal((await failed.json()).code, "MONITOR_NOT_READY"); assert.equal(reads, 0);
  health = "OK";
  const saved = await api("/api/google-chat", { method: "PUT", body: config }); assert.equal(saved.monitorReady, true);
  const checked = await rawCheck(); assert.equal(checked.status, 200); const check = await checked.json(); assert.equal(check.check.messages, 1); assert.equal(check.diagnostics.body.code, "OK");
  loseLogin = true;
  const lost = await rawCheck(); assert.equal(lost.status, 400); assert.equal((await lost.json()).code, "MONITOR_NOT_READY");
  const status = await api("/api/google-chat"); assert.equal(status.monitorReady, false); assert.equal(status.state, "LOGIN_REQUIRED");
  const messages = (await api(`/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages;
  assert(!messages.some(message => message.text?.includes("接続しました")), "Configuration save falsely advertised connection success");
  assert(!messages.some(message => message.text?.includes("新着はこの会話へ自動")), "Configuration save promised unverified delivery");
  assert.equal(modelCalls, 0); assert.equal(status.cursor, 0);
  loseLogin = false; health = "OK";
  await api("/api/google-chat", { method: "PUT", body: config });
  const incoming = { id: "synthetic-new", sender: { name: "架空の試験者" }, space: { name: "架空スペース" }, thread: { id: "synthetic-thread" }, direction: "incoming", timestamp: "2026-10-30T00:00:00Z", text: "本人さん、架空の出勤時間への返答を明日までにお願いします。これは本文転送を検出する固有の架空文です。" };
  const notices = async () => (await api(`/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.filter(message => message.googleChatEventId);
  modelAnswer = JSON.stringify({ kind: "general_notification", category: "direct_request", summary: "明日までに出勤時刻への返答が必要だよ。" });
  events.push({ seq: 1, kind: "created", message: incoming });
  await until(async () => (await api("/api/google-chat")).cursor === 1);
  assert.equal((await notices()).length, 1); assert(!(await notices())[0].text.includes(incoming.text)); assert.equal(modelCalls, 1);
  child.kill("SIGTERM"); await new Promise(done => child.once("exit", done)); child = start();
  await until(async () => fetch(base + "/api/health").then(response => response.ok).catch(() => false));
  events.push({ seq: 2, kind: "updated", message: { ...incoming, sender: { name: "名前を読み込み中..." } } });
  await until(async () => (await api("/api/google-chat")).cursor === 2);
  assert.equal((await notices()).length, 1); assert.equal(modelCalls, 1);
  modelAnswer = JSON.stringify({ kind: "general_notification", category: "schedule_change", summary: "出勤が15時へ変更されたので、再確認への返答が必要だよ。" });
  events.push({ seq: 3, kind: "updated", message: { ...incoming, previousText: incoming.text, text: "本人さん、出勤を15時に変更しました。再確認の返答をお願いします。" } });
  await until(async () => (await api("/api/google-chat")).cursor === 3);
  assert.equal((await notices()).length, 2); assert.equal(modelCalls, 2);
  assert(JSON.stringify(modelInputs[1]).includes("previousText")); assert(JSON.stringify(modelInputs[1]).includes("previousNotice"));
  modelAnswer = '{"kind":"ignore"}';
  events.push({ seq: 4, kind: "created", message: { ...incoming, id: "synthetic-chatter", text: "皆さんお疲れ様です。" } });
  await until(async () => (await api("/api/google-chat")).cursor === 4);
  assert.equal((await notices()).length, 2); assert.equal(modelCalls, 3);
  modelAnswer = 'invalid classifier output';
  events.push({ seq: 5, kind: "created", message: { ...incoming, id: "synthetic-failure", text: "本人さん、別件の確認をお願いします。" } });
  await until(async () => (await api("/api/google-chat")).state === "CLASSIFIER_FAILED");
  assert.equal((await api("/api/google-chat")).cursor, 4); assert.equal((await notices()).length, 2);
  modelAnswer = '{"kind":"ignore"}';
  await until(async () => (await api("/api/google-chat")).cursor === 5);
  const evidence = { ok: true, syntheticDataOnly: true, packagedServer: true, unrelatedRoutesContinue: true, offlineSaveNotReady: true, repeatedSaveNoSuccessMessage: true, offlineCheckRejectsCachedBody: true, loginLostDuringCheckRejected: true, healthyBodyCount: 1, aiJudgmentRequired: true, fullBodyNotForwarded: true, restartDuplicateSuppressed: true, trueEditJudged: true, chatterSilent: true, failedClassificationPending: true, judgmentHasNoTools: true, noticeCount: (await notices()).length, modelCalls, chatWrites: 0 };
  if (ownerToken) evidence.ui = await (await import("./testing/google-chat-ui-smoke.mjs")).checkGoogleChatFixtureUi(base, ownerHeaders);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) { console.error(logs.slice(-5000)); throw error; }
finally {
  child.kill("SIGTERM"); if (child.exitCode === null) await new Promise(done => child.once("exit", done));
  bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { verificationServerEnvironment } from "./control-omb.ts";
import { request, handleToolCall } from "./mcp-server.ts";
import { CodexSharedClient } from "../server/codex-shared-client.ts";
import { nativeTurn } from "../server/direct-codex-client.ts";

const root = realpathSync(mkdtempSync("/private/tmp/omb-direct-fixture-shared-")), data = join(root, "data"), home = join(root, "native"), socket = join(root, "native.sock"), repo = process.cwd();
mkdirSync(data); mkdirSync(home); mkdirSync(join(data, "tmp"));
const engine = createServer(), wss = new WebSocketServer({ server: engine }), subscribed = new Set(), rpc = [], decisions = [], pending = new Map();
const threadId = "fixture-original", history = [{ id: "baseline", status: "completed", items: [] }]; let current, nextRequest = 100;
const emit = (method, params) => { for (const ws of subscribed) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params: { threadId, ...params } })); };
const finish = (turn, text) => {
  const answer = { type: "agentMessage", id: randomUUID(), text, phase: "final_answer" };
  turn.items.push(answer); turn.status = "completed"; history.push(turn); current = undefined;
  emit("item/completed", { turnId: turn.id, item: answer }); emit("turn/completed", { turn });
};
wss.on("connection", ws => {
  ws.on("close", () => subscribed.delete(ws));
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString()), { method, params, id } = message;
    if (!method) {
      const job = pending.get(id); if (!job) return; pending.delete(id); decisions.push(message.result);
      emit("serverRequest/resolved", { requestId: id }); finish(job.turn, message.result.decision === "accept" || message.result.success ? "架空のツール完了" : "架空の操作中止"); return;
    }
    rpc.push({ method, params }); if (id === undefined) return;
    const reply = result => ws.send(JSON.stringify({ id, result }));
    if (method === "thread/resume") { subscribed.add(ws); return reply({ thread: { id: threadId, status: { type: current ? "active" : "idle" } } }); }
    if (method === "thread/unsubscribe") { subscribed.delete(ws); return reply({}); }
    if (method === "thread/read") return reply({ thread: { id: threadId } });
    if (method === "thread/turns/list") return reply({ data: history.slice().reverse().slice(0, params.limit) });
    if (method === "turn/start") {
      if (current) return ws.send(JSON.stringify({ id, error: { message: "thread already working" } }));
      const text = params.input[0].text, turn = { id: randomUUID(), status: "inProgress", items: [{ id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input }] }; current = turn;
      reply({ turn: { id: turn.id } }); emit("turn/started", { turn: { id: turn.id } });
      if (text.includes("REQ_APPROVAL") || text.includes("REQ_TOOL")) {
        const nativeId = nextRequest++, tool = text.includes("REQ_TOOL"), method = tool ? "item/tool/call" : "item/commandExecution/requestApproval";
        pending.set(nativeId, { turn });
        for (const peer of subscribed) peer.send(JSON.stringify({ id: nativeId, method, params: { threadId, turnId: turn.id, ...(tool ? { tool: "fixture_echo", arguments: {} } : { command: "synthetic fixture operation" }) } }));
      } else finish(turn, "架空の元回答: " + text);
      return;
    }
    reply({});
  });
});
engine.listen(socket); await once(engine, "listening"); chmodSync(socket, 0o600);
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = reservation.address().port; await new Promise(r => reservation.close(r));
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(repo, "server/testing/fake-claude-cli.ts") } } }, decider: { enabled: false }, newBotDefaults: { profile: { computer: "off", browser: false } } }));
const env = { ...verificationServerEnvironment({}, data, port), OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off", OMB_NATIVE_CODEX_CLI: join(repo, "server/testing/fake-direct-codex.ts"), OMB_NATIVE_CODEX_HOME: home, OMB_NATIVE_CODEX_SOCKET: socket };
if (process.env.OMB_DIRECT_FIXTURE_UI) env.OMB_STATIC_DIR = process.env.OMB_DIRECT_FIXTURE_UI;
const child = spawn(process.execPath, [process.env.OMB_DIRECT_FIXTURE_SERVER ?? join(repo, "server/index.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] }); let logs = "";
child.stdout.on("data", s => logs += s); child.stderr.on("data", s => logs += s);
const url = `http://127.0.0.1:${port}`, api = (path, options) => request(path, options?.body && typeof options.body !== "string" ? { ...options, body: JSON.stringify(options.body) } : options, url);
const tool = (name, args) => handleToolCall(name, args, api);
async function until(read, accept) { const deadline = Date.now() + 30000; for (;;) { const value = await read(); if (accept(value)) return value; if (child.exitCode !== null || Date.now() > deadline) throw Error("Shared fixture did not settle"); await new Promise(r => setTimeout(r, 20)); } }
let app; const appRequests = [];
try {
  await until(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, Boolean);
  app = new CodexSharedClient(socket); await app.initialize(); app.onAsk(ask => appRequests.push(ask)); await app.request("thread/resume", { threadId, excludeTurns: true });
  const { bot } = await tool("create_bot", { name: "Synthetic shared M1" }), source = bot.activeTaskId;
  const model = { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 10000 };
  const binding = { botId: bot.id, threadId: source, codexThreadId: threadId, hostId: "local", enabled: true, mediator: model, formatter: model };
  await api("/api/direct-codex", { method: "PUT", body: { bindings: [binding] } });
  const messages = async () => (await api(`/api/threads/${source}/messages?limit=100`)).messages;
  await tool("send_bot_message", { bot_id: bot.id, text: "REQ_APPROVAL_FROM_M1" });
  await until(async () => appRequests, xs => xs.some(a => a.method === "item/commandExecution/requestApproval"));
  await until(messages, xs => xs.some(m => m.card?.requestType === "permission"));
  appRequests.find(a => a.method === "item/commandExecution/requestApproval").answer({ decision: "accept" });
  await until(messages, xs => xs.some(m => m.nativeCodex?.formatted));
  assert.equal((await messages()).filter(m => m.card?.requestType === "permission").length, 1);
  assert((await messages()).find(m => m.card?.requestType === "permission").card.expired);
  const appTurn = nativeTurn(app, binding, { requestId: randomUUID(), text: "REQ_APPROVAL_FROM_APP" }, AbortSignal.timeout(30000), () => {}); void appTurn.catch(() => {});
  const rows = await until(messages, xs => xs.some(m => m.card?.requestType === "permission" && !m.card.expired && !m.card.answered));
  const card = rows.find(m => m.card?.requestType === "permission" && !m.card.expired && !m.card.answered);
  const accepted = await api(`/api/threads/${source}/respond`, { method: "POST", body: { requestId: card.card.requestId, behavior: "allow" } }); assert.equal(accepted.outcome, "allowed-once");
  assert.equal((await appTurn).text, "架空のツール完了");
  await until(messages, xs => xs.filter(m => m.nativeCodex?.originalText === "架空のツール完了").length === 2);
  const normal = await nativeTurn(app, binding, { requestId: randomUUID(), text: "APP_INPUT_VISIBLE" }, AbortSignal.timeout(30000), () => {}); assert(normal.text.includes("APP_INPUT_VISIBLE"));
  await until(messages, xs => xs.some(m => m.role === "user" && m.text === "APP_INPUT_VISIBLE") && xs.some(m => m.nativeCodex?.originalText?.includes("APP_INPUT_VISIBLE")));
  await tool("send_bot_message", { bot_id: bot.id, text: "REQ_TOOL_FROM_M1" });
  const asks = await until(async () => appRequests, xs => xs.some(a => a.method === "item/tool/call"));
  asks.find(a => a.method === "item/tool/call").answer({ contentItems: [{ type: "inputText", text: "fixture" }], success: true });
  await until(messages, xs => xs.filter(m => m.nativeCodex?.originalText === "架空のツール完了").length === 3);
  assert.equal(decisions.length, 3); assert(decisions.filter(d => d.decision).every(d => d.decision === "accept"));
  assert.equal(rpc.filter(c => c.method === "turn/start").length, 4); assert.equal(rpc.filter(c => c.method === "thread/fork").length, 0);
  assert(rpc.filter(c => ["thread/resume", "turn/start"].includes(c.method)).every(c => c.params.threadId === threadId));
  const report = { ok: true, testedAt: new Date().toISOString(), server: process.env.OMB_DIRECT_FIXTURE_SERVER ?? "source", syntheticOnly: true, isolatedHome: true, sameNativeThreadId: true, forkCalls: 0, m1ToAppApproval: true, appToM1Approval: true, otherClientResolutionExpiresCard: true, noDuplicatePermissionCards: true, appInputAndAnswerImported: true, dynamicToolHandledByAppSubscriber: true, nativeTurns: 4, explicitDecisions: 3, noAutomaticRetry: true };
  writeFileSync(join(repo, ".privacy-dev/direct-codex-bridge/shared-acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
} catch (error) { writeFileSync(join(repo, ".privacy-dev/direct-codex-bridge/shared-acceptance-error.log"), logs, { mode: 0o600 }); throw error; }
finally { if (app) await app.close(); if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => engine.close(r)); rmSync(root, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { verificationServerEnvironment } from "./control-omb.ts";
import { request, handleToolCall } from "./mcp-server.ts";

const root = mkdtempSync(join(tmpdir(), "omb-direct-fixture-"));
const data = join(root, "data"), native = join(root, "native"); mkdirSync(data); mkdirSync(native);
mkdirSync(join(data, "tmp"));
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const repo = process.cwd(), fake = join(repo, "server/testing/fake-direct-codex.ts"); chmodSync(fake, 0o755);
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(repo, "server/testing/fake-claude-cli.ts") } } }, decider: { enabled: false }, newBotDefaults: { profile: { computer: "off", browser: false } } }));
const env = { ...verificationServerEnvironment({}, data, port), OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off", OMB_NATIVE_CODEX_CLI: fake, OMB_NATIVE_CODEX_HOME: native };
if (process.env.OMB_DIRECT_FIXTURE_UI) env.OMB_STATIC_DIR = process.env.OMB_DIRECT_FIXTURE_UI;
const child = spawn(process.execPath, [process.env.OMB_DIRECT_FIXTURE_SERVER ?? join(repo, "server/index.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
const url = `http://127.0.0.1:${port}`;
const api = (path, opts) => request(path, opts?.body && typeof opts.body !== "string" ? { ...opts, body: JSON.stringify(opts.body) } : opts, url);
const tool = (name, args) => handleToolCall(name, args, api);
const until = async (read, accept) => {
  const deadline = Date.now() + 30000;
  for (;;) { const value = await read(); if (accept(value)) return value; if (child.exitCode !== null || Date.now() > deadline) throw new Error("Native fixture did not settle"); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const calls = () => existsSync(join(native, "rpc.jsonl")) ? readFileSync(join(native, "rpc.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
try {
  await until(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, Boolean);
  const { bot } = await tool("create_bot", { name: "Synthetic direct native" });
  const binding = { botId: bot.id, threadId: bot.activeTaskId, codexThreadId: "fixture-native", hostId: "local", enabled: true, formatter: { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 10000 } };
  await api("/api/direct-codex", { method: "PUT", body: { bindings: [binding] } });
  const messages = () => api(`/api/threads/${binding.threadId}/messages?limit=100`);
  const settled = () => until(messages, value => value.messages.filter(m => m.nativeCodex?.formatted).length >= 1);
  const text = "架空の直接接続テスト\n原文はそのまま";
  const sent = await tool("send_bot_message", { bot_id: bot.id, text });
  await settled();
  const first = (await messages()).messages.find(m => m.nativeCodex?.formatted);
  assert.equal(first.text, "短縮した架空の回答"); assert.equal(first.nativeCodex.originalText, "架空の元回答: " + text);
  const start = calls().filter(call => call.method === "turn/start"); assert.equal(start.length, 1); assert.equal(start[0].params.input[0].text, text);
  assert.deepEqual(Object.keys(start[0].params).sort(), ["clientUserMessageId", "input", "threadId"]);
  const resume = calls().find(call => call.method === "thread/resume"); assert.deepEqual(Object.keys(resume.params).sort(), ["excludeTurns", "threadId"]);
  const stored = JSON.parse(readFileSync(join(native, "turns.json"), "utf8"));
  assert(stored.some(t => t.items.some(i => i.type === "userMessage" && i.content[0].text === text)));
  writeFileSync(join(native, "hold"), "1");
  await tool("send_bot_message", { bot_id: bot.id, text: "先頭の架空入力" });
  await until(async () => calls(), value => value.filter(call => call.method === "turn/start").length === 2);
  const send = text => api(`/api/bots/${bot.id}/messages`, { method: "POST", body: { threadId: binding.threadId, text, delivery: "queue" } });
  assert.equal((await send("キューの架空入力A")).queued, true);
  assert.equal((await send("キューの架空入力B")).queued, true);
  rmSync(join(native, "hold"));
  await until(messages, value => value.messages.filter(m => m.nativeCodex?.formatted).length >= 4);
  assert.deepEqual(calls().filter(call => call.method === "turn/start").map(call => call.params.input[0].text), [text, "先頭の架空入力", "キューの架空入力A", "キューの架空入力B"]);
  assert.equal((await messages()).messages.filter(m => m.role === "user" && m.text === "キューの架空入力A").length, 1);
  const turns = JSON.parse(readFileSync(join(native, "turns.json"), "utf8")); turns.push({ id: "app-side", status: "completed", items: [{ id: "app-user", type: "userMessage", content: [{ type: "text", text: "アプリ側の架空入力" }] }, { id: "app-answer", type: "agentMessage", text: "アプリ側の架空回答" }] });
  writeFileSync(join(native, "turns.json"), JSON.stringify(turns));
  await api("/api/direct-codex", { method: "POST", body: {} });
  await until(messages, value => value.messages.some(m => m.nativeCodex?.itemId === "app-answer" && m.nativeCodex.formatted));
  await api("/api/direct-codex", { method: "POST", body: {} });
  assert.equal((await messages()).messages.filter(m => m.nativeCodex?.itemId === "app-user").length, 1);
  assert.equal(calls().filter(call => call.method === "turn/start").length, 4);
  const configured = await api("/api/direct-codex");
  configured.settings.bindings[0].mediator = binding.formatter;
  await api("/api/direct-codex", { method: "PUT", body: configured.settings });
  await tool("send_bot_message", { bot_id: bot.id, text: "仲介の架空入力" });
  await until(messages, value => value.messages.some(m => m.nativeCodex?.formatted && m.nativeCodex.originalText?.includes('"user_request":"仲介の架空入力"')));
  const mediated = calls().filter(call => call.method === "turn/start").at(-1);
  const mediatedPayload = JSON.parse(mediated.params.input[0].text.split("\n").slice(1).join("\n"));
  assert.equal(mediatedPayload.user_request, "仲介の架空入力"); assert.equal(mediatedPayload.mediator_note, "短縮した架空の回答");
  const report = { ok: true, testedAt: new Date().toISOString(), server: process.env.OMB_DIRECT_FIXTURE_SERVER ?? "source", isolatedHome: true, loopbackOnly: true,
    nativeUserInputExact: true, nativeHistoryPreserved: true, noBotInstructionsOrOverrides: true, rawAnswerPreserved: true, independentFormatter: true,
    queuedInputsSeparate: true, queuedUserRowsNotDuplicated: true, appSideMessagesImportedOnce: true, noFormattedOutputSentToNative: true, mediatedInputOriginalPreserved: true, nativeTurns: 5, receiptAccepted: Boolean(sent) };
  writeFileSync(join(repo, ".privacy-dev/direct-codex-bridge/acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
} catch (error) {
  writeFileSync(join(repo, ".privacy-dev/direct-codex-bridge/fixture-error.log"), logs, { mode: 0o600 }); throw error;
} finally {
  const exited = once(child, "exit"); child.kill("SIGTERM"); if (child.exitCode === null) await exited;
  rmSync(root, { recursive: true, force: true });
}

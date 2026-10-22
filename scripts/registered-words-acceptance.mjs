import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request, handleToolCall } from "./mcp-server.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "omb-words-acceptance-"));
const data = join(fixture, "data"); const home = join(fixture, "home");
await mkdir(data, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
const packets = []; let logs = "";
const originals = ["星野架空", "ほしのかくう", "Kaku Hoshino", "hoshino@example.invalid", "1234567", "sk-proj-SYNTHETIC123456789"];
const raw = `${originals.slice(0, 3).join(" / ")}\nメール: ${originals[3]}\n住所: 東京都架空区架空町1丁目2番3号\n電話: 090-1234-5678\n口座番号: ${originals[4]}\nAPIキー: ${originals[5]}`;
const resultFile = join(fixture, "result.json");
await writeFile(resultFile, JSON.stringify({ content: [{ type: "text", text: raw }], structuredContent: { author: originals[0], email: originals[3] } }));
const upstream = join(fixture, "read.cjs");
await writeFile(upstream, `const {createInterface}=require('node:readline');const fs=require('node:fs');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'read',description:'Read synthetic fixture only',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};if(m.method==='tools/call')result=JSON.parse(fs.readFileSync(process.env.FIXTURE_RESULT,'utf8'));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
const listen = s => new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", () => resolve(s.address().port)); });
const mock = createServer(async (req, res) => {
  if (req.method === "GET") { res.end('{"data":[{"id":"fixture"}]}'); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body); packets.push(payload);
  const hasResult = payload.messages.some(m => m.role === "tool");
  const name = payload.tools?.find(t => t.function.name.endsWith("privacy_fixture_read"))?.function.name;
  const message = hasResult || !name ? { role: "assistant", content: "⟦ユーザーA⟧さんへの返信案です。内容を確認してください。" }
    : { role: "assistant", content: null, tool_calls: [{ id: "synthetic-read", type: "function", function: { name, arguments: "{}" } }] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: hasResult || !name ? "stop" : "tool_calls" }] }));
});
const mockPort = await listen(mock);
const reservation = createServer(); const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
await writeFile(join(data, "config.json"), JSON.stringify({
  instances: { fixture: { driver: "openai-compat", config: { url: `http://127.0.0.1:${mockPort}/v1`, key: "synthetic-only", model: "fixture", tools: true } } },
  mcpServers: { privacy_fixture: { command: process.execPath, args: [upstream], env: { FIXTURE_RESULT: resultFile }, enabled: true } },
  decider: { enabled: false }, newBotDefaults: { profile: { approvalMode: "full", computer: "off", browser: false, composio: false, mcpServers: ["privacy_fixture"] } },
}), { mode: 0o600 });
const child = spawn(process.execPath, ["server/index.ts"], { cwd: repo, env: {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0", OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off",
}, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", c => { logs += c; }); child.stderr.on("data", c => { logs += c; });
const url = `http://127.0.0.1:${port}`;
const api = (path, options) => request(path, options?.body && typeof options.body !== "string" ? { ...options, body: JSON.stringify(options.body) } : options, url);
const tool = (name, args) => handleToolCall(name, args, api);
const until = async (read, accept, timeout = 150_000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > deadline) throw new Error("Isolated automation fixture timed out"); await new Promise(resolve => setTimeout(resolve, 100)); }
};
try {
  await until(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, Boolean, 45_000);
  const settings = { enabled: true, allRoutines: true, routineIds: [], sources: ["custom"], aliases: [{ replacement: "ユーザーA", variants: originals.slice(0, 3) }] };
  await api("/api/privacy/settings", { method: "PUT", body: settings });
  assert.equal((await api("/api/privacy/settings")).mode, "registered-words");
  const { bot } = await tool("create_bot", { name: "Synthetic automation only", instance_id: "fixture", model: "fixture" });
  await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { approvalMode: "full", mcpServers: ["privacy_fixture"], computer: "off", browser: false, composio: false } });
  await tool("send_bot_message", { bot_id: bot.id, text: "Use privacy_fixture_read once and draft a reply. Synthetic fixture only." });
  await tool("wait_for_conversation", { target_type: "bot", target_id: bot.id, timeout_seconds: 45 });
  assert(packets.some(p => p.messages.some(m => m.role === "tool" && JSON.stringify(m).includes(originals[0]))), "Ordinary chat must remain unfiltered");
  const before = packets.length;
  const { routine } = await api("/api/routines", { method: "POST", body: { name: "Synthetic privacy schedule", botId: bot.id, enabled: true, prompt: "Use privacy_fixture_read exactly once; draft a reply for 星野架空. Synthetic only.", schedule: { type: "once", at: Date.now() + 1500 }, runOn: "maus" } });
  await until(async () => (await api("/api/routines")).runs.find(r => r.routineId === routine.id), r => ["completed", "failed"].includes(r?.status));
  const scheduled = packets.slice(before);
  assert(scheduled.some(p => p.messages.some(m => m.role === "tool")), "Scheduled run must call the synthetic MCP tool");
  for (const original of originals.slice(0, 3)) assert(!JSON.stringify(scheduled).includes(original), "Original reached scheduled mock AI");
  assert(JSON.stringify(scheduled).includes("ユーザーA"));
  assert(JSON.stringify(scheduled).includes("hoshino@example.invalid"), "Unregistered email must remain unchanged");
  const run = (await api("/api/routines")).runs.find(r => r.routineId === routine.id);
  const restored = await api(`/api/threads/${run.threadId}/privacy/display`, { method: "POST", body: { text: "⟦ユーザーA⟧" } });
  assert.equal(restored.text, originals[0]);
  await writeFile(resultFile, JSON.stringify({ content: [{ type: "image", mimeType: "image/png", data: "synthetic-only" }] }));
  const failedBefore = packets.length;
  const { run: binaryRun } = await api(`/api/routines/${routine.id}/run`, { method: "POST", body: {} });
  await until(async () => (await api("/api/routines")).runs.find(r => r.id === binaryRun.id), r => ["completed", "failed"].includes(r?.status));
  const binaryPackets = JSON.stringify(packets.slice(failedBefore));
  assert(/BODY_INVALID|MASK_FAILED/u.test(binaryPackets)); assert(!binaryPackets.includes("synthetic-only"));
  await writeFile(join(data, "private/settings.json"), "invalid", { mode: 0o600 });
  const beforeFailure = packets.length;
  const { run: failedRun } = await api(`/api/routines/${routine.id}/run`, { method: "POST", body: {} });
  await until(async () => (await api("/api/routines")).runs.find(r => r.id === failedRun.id), r => r?.status === "failed");
  assert.equal(packets.length, beforeFailure, "Filter errors must prevent prompt dispatch");
  assert(!logs.includes(originals[0]));
  const report = { ok: true, testedAt: new Date().toISOString(), modelInferenceRemoved: true, registeredWordsOnly: true, scheduledMockRequests: scheduled.length, scheduledPromptAndMcpResultsMasked: true, ordinaryChatUnchanged: true, customAliasDisplayRestore: true, binaryResultBlocked: true, corruptFilterNoDispatch: true, syntheticDataOnly: true };
  await writeFile(join(repo, ".privacy-dev/evidence/registered-words-acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  await new Promise(resolve => mock.close(resolve)); await rm(fixture, { recursive: true, force: true });
}

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { handleToolCall, request } from "./mcp-server.ts";
import { createProxyHandler } from "../companion/src/proxy.ts";
import { preparePersonalCodexHome } from "../electron/personal-codex-home.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = await realpath(await mkdtemp(join(tmpdir(), "omb-personal-acceptance-")));
const data = join(fixture, "data");
const live = process.argv.includes("--live-codex");
const packets = [];
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const mock = createServer(async (req, res) => {
  if (req.url === "/v1/models") { res.end('{"data":[{"id":"fixture"}]}'); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  packets.push(JSON.parse(body));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "⟦人物_001⟧さんへ、承知しましたと返信します。" }, finish_reason: "stop" }] }));
});
const mockPort = await listen(mock);
const reservation = createServer(); const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
await mkdir(data, { mode: 0o700 }); await mkdir(join(fixture, "home"), { mode: 0o700 });
const instances = { fixture: { driver: "openai-compat", config: { url: `http://127.0.0.1:${mockPort}/v1`, key: "synthetic-only", model: "fixture", tools: false } } };
if (live) instances.codex = { driver: "codex", config: { cli: "/opt/homebrew/bin/codex" }, environment: preparePersonalCodexHome({
  directory: join(data, "private", "codex"), loginHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
}) };
await writeFile(join(data, "config.json"), JSON.stringify({ instances, decider: { enabled: false }, newBotDefaults: { profile: { approvalMode: "ask", computer: "off", browser: false, composio: false, mcpServers: [] } } }), { mode: 0o600 });
const child = spawn(process.execPath, ["server/index.ts"], { cwd: repo, env: {
  PATH: process.env.PATH, HOME: join(fixture, "home"), USERPROFILE: join(fixture, "home"), OMB_DATA_DIR: data,
  OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0", OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off",
  OMB_PRIVACY_PYTHON: join(repo, ".privacy-dev/venv/bin/python"), OMB_PRIVACY_WORKER: join(repo, "scripts/privacy-worker.py"),
  OMB_PRIVACY_DEVICE: "mps", OMB_PRIVACY_CHECKPOINT: join(repo, ".privacy-dev/checkpoint/original"), TIKTOKEN_CACHE_DIR: join(repo, ".privacy-dev/tiktoken"),
}, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", c => { logs += c; }); child.stderr.on("data", c => { logs += c; });
const url = `http://127.0.0.1:${port}`;
const api = (path, options) => request(path, options, url);
const tool = (name, args) => handleToolCall(name, args, api);
const deviceToken = randomUUID();
const sidecar = createServer(createProxyHandler({ harnessPort: port, authenticate: token => token === deviceToken ? { id: "synthetic-phone", cloudDesktopAccess: false, browserControlAccess: false } : null, redeem: () => ({ error: "fixture only" }), serverName: () => "Synthetic Mac" }));
const devicePort = await listen(sidecar);
const phone = (path, text) => fetch(`http://127.0.0.1:${devicePort}${path}`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ text, names: ["星野 架空"] }) });
try {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { if ((await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error("Isolated personal server did not start");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const { bot } = await tool("create_bot", { name: "Personal privacy acceptance", instance_id: "fixture", model: "fixture" });
  const maskPath = `/api/threads/${bot.activeTaskId}/privacy/mask`;
  assert.equal((await fetch(`http://127.0.0.1:${devicePort}${maskPath}`, { method: "POST" })).status, 401);
  const raw = "氏名: 星野 架空\nメール: hoshino@example.invalid\n口座番号: 1234567\nこの方への返信を作成してください。";
  const start = Date.now();
  const maskedResponse = await phone(maskPath, raw);
  assert.equal(maskedResponse.status, 200);
  const masked = (await maskedResponse.json()).text;
  const maskMs = Date.now() - start;
  for (const original of ["星野 架空", "hoshino@example.invalid", "1234567"]) assert(!masked.includes(original));
  assert.equal(packets.length, 0);
  await tool("send_bot_message", { bot_id: bot.id, text: masked });
  await tool("wait_for_conversation", { target_type: "bot", target_id: bot.id, timeout_seconds: 30 });
  assert.equal(packets.length, 1);
  for (const original of ["星野 架空", "hoshino@example.invalid", "1234567"]) assert(!JSON.stringify(packets).includes(original));
  const response = await phone(`/api/threads/${bot.activeTaskId}/privacy/display`, "⟦人物_001⟧さんへ、承知しましたと返信します。");
  assert.equal(response.status, 200); assert((await response.json()).text.includes("星野 架空"));
  const messages = await tool("get_bot_messages", { bot_id: bot.id, limit: 20 });
  assert(!JSON.stringify(messages).includes("星野 架空"));
  assert(!logs.includes("星野 架空"));
  const before = packets.length;
  await writeFile(join(data, "private/terms.json"), "invalid", { mode: 0o600 });
  assert.equal((await phone(maskPath, raw)).status, 503);
  assert.equal(packets.length, before);
  let codexCompleted = false;
  if (live) {
    const { instances: described } = await api("/api/instances");
    const codex = described.find(i => i.instanceId === "codex");
    assert.equal(codex?.snapshot.authenticated, true, "Existing Codex ChatGPT login must be recognized");
    const { bot: liveBot } = await tool("create_bot", { name: "Codex login acceptance", instance_id: "codex", model: codex.models.default });
    await tool("send_bot_message", { bot_id: liveBot.id, text: "This is a synthetic connectivity check. Reply with READY only. Do not use tools or read files." });
    await tool("wait_for_conversation", { target_type: "bot", target_id: liveBot.id, timeout_seconds: 120 });
    const result = await tool("get_bot_messages", { bot_id: liveBot.id, limit: 20 });
    assert(result.messages.some(m => m.role === "bot" && m.text?.includes("READY")), "Codex must complete a real turn using the existing ChatGPT login");
    codexCompleted = true;
  }
  const report = { ok: true, date: new Date().toISOString(), maskMs, realMpsModel: true, pairedPhoneProxy: true, rawAbsentFromMock: true, originalsAbsentFromConversationAndLogs: true, displayOnlyRestore: true, failureDoesNotSend: true, codexCompleted, packets: packets.length };
  await writeFile(join(repo, ".privacy-dev/evidence/personal-acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  await new Promise(resolve => sidecar.close(resolve)); await new Promise(resolve => mock.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}

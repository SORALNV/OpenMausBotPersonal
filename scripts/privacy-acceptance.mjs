import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { handleToolCall, request } from "./mcp-server.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "omb-privacy-acceptance-"));
const data = join(fixture, "data");
const packets = [];
const appToken = randomUUID();
const api = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  assert.equal(req.url, "/v1/chat/completions");
  packets.push(JSON.parse(body));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "⟦人物_001⟧へ返信します。" }, finish_reason: "stop" }] }));
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const apiPort = await listen(api);
const reservation = createServer();
const port = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
await mkdir(join(data, "private"), { recursive: true, mode: 0o700 });
await mkdir(join(fixture, "home"), { mode: 0o700 });
await writeFile(join(data, "config.json"), JSON.stringify({ instances: { privacy: {
  driver: "openai-compat", displayName: "Synthetic privacy API", config: {
    url: `http://127.0.0.1:${apiPort}/v1`, key: "synthetic-key", model: "fixture", managedModels: ["fixture"], tools: false,
  },
} }, decider: { enabled: false } }), { mode: 0o600 });
await writeFile(join(data, "private/terms.json"), JSON.stringify([{ text: "星野 架空", label: "private_person" }]), { mode: 0o600 });
const child = spawn(process.execPath, ["--import", "./server/privacy/preload.ts", "server/index.ts"], {
  cwd: repo,
  env: {
    PATH: process.env.PATH, HOME: join(fixture, "home"), USERPROFILE: join(fixture, "home"),
    OMB_DATA_DIR: data, OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0", OMB_UI_PORT: "5299",
    OMB_PRIVACY_MODE: "strict", OMB_PRIVACY_DEV_ROOT: fixture,
    OMB_PRIVACY_APP_TOKEN: appToken,
    OMB_PRIVACY_PYTHON: join(repo, ".privacy-dev/venv/bin/python"),
    OMB_PRIVACY_WORKER: join(repo, "scripts/privacy-worker.py"),
    OMB_PRIVACY_DEVICE: process.env.OMB_PRIVACY_DEVICE ?? "auto",
    OMB_PRIVACY_CHECKPOINT: join(repo, ".privacy-dev/checkpoint/original"), TIKTOKEN_CACHE_DIR: join(repo, ".privacy-dev/tiktoken"),
  }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", data => { logs += data; });
child.stderr.on("data", data => { logs += data; });
const url = `http://127.0.0.1:${port}`;
const fetcher = (path, options) => request(path, options, url);
const tool = (name, args) => handleToolCall(name, args, fetcher);
const start = Date.now();
try {
  for (;;) {
    try { await fetcher("/api/health"); break; } catch {
      if (child.exitCode !== null || Date.now() - start > 30_000) throw new Error(`Fixture did not start: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const statusUrl = url + "/api/privacy/status";
  assert.equal((await fetch(statusUrl)).status, 403);
  assert.equal((await fetch(statusUrl, { headers: { "x-omb-privacy-instance": "wrong" } })).status, 403);
  const appStatus = await fetch(statusUrl, { headers: { "x-omb-privacy-instance": appToken } });
  assert.equal(appStatus.status, 200);
  assert.equal(appStatus.headers.get("x-omb-privacy-instance"), appToken);
  assert.deepEqual(await appStatus.json(), { mode: "strict", device: process.env.OMB_PRIVACY_DEVICE ?? "auto", ready: true });
  const { bot } = await tool("create_bot", { name: "Synthetic Privacy Probe", instance_id: "privacy", model: "fixture" });
  const raw = "氏名: 星野 架空\n住所: 東京都架空区試験町1-2-3\nメール: hoshino@example.invalid\n電話: 090-1234-5678\n口座番号: 1234567\nAPIキー: sk-proj-SYNTHETICKEY01234567890";
  const secrets = ["星野 架空", "東京都架空区試験町1-2-3", "hoshino@example.invalid", "090-1234-5678", "1234567", "sk-proj-SYNTHETICKEY01234567890"];
  const firstTurnStart = Date.now();
  await tool("send_bot_message", { bot_id: bot.id, text: raw });
  const first = await tool("wait_for_conversation", { target_type: "bot", target_id: bot.id, timeout_seconds: 120 });
  assert(packets.length > 0, `No protected packet reached the mock: ${JSON.stringify(first)} ${logs}`);
  const firstTurnMs = Date.now() - firstTurnStart;
  const secondTurnStart = Date.now();
  await tool("send_bot_message", { bot_id: bot.id, text: "履歴の星野 架空と hoshino@example.invalid を参照して続きを作ってください。" });
  await tool("wait_for_conversation", { target_type: "bot", target_id: bot.id, timeout_seconds: 120 });
  assert.equal(packets.length, 2);
  const secondTurnMs = Date.now() - secondTurnStart;
  for (const packet of packets) {
    for (const secret of secrets) assert(!JSON.stringify(packet).includes(secret), `Synthetic plaintext reached transport: ${secret}`);
    assert(!packet.tools);
  }
  assert(JSON.stringify(packets[1]).includes("⟦人物_001⟧"));
  const messages = await tool("get_bot_messages", { bot_id: bot.id, limit: 30 });
  assert(messages.messages.some(m => m.role === "bot" && m.text?.includes("⟦人物_001⟧")));
  const restored = await fetcher("/api/privacy/display", { method: "POST", body: JSON.stringify({ threadId: bot.activeTaskId, text: "⟦人物_001⟧へ返信します。" }) });
  assert.equal(restored.text, "星野 架空へ返信します。");
  for (const path of ["/api/attachments/test", "/api/live/calls", "/api/tts", "/api/internal/agents/mcp"]) {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);
  }
  const upgrade = await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("GET /api/desktop-viewer HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
    let response = "";
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("WebSocket refusal timed out")); });
    socket.on("data", data => { response += data; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
  assert(String(upgrade).startsWith("HTTP/1.1 403"));
  const before = packets.length;
  await writeFile(join(data, "private/terms.json"), "malformed", { mode: 0o600 });
  await tool("send_bot_message", { bot_id: bot.id, text: "氏名: 星野 架空" });
  await tool("wait_for_conversation", { target_type: "bot", target_id: bot.id, timeout_seconds: 30 });
  assert.equal(packets.length, before, "Filter failure must not send a packet");
  for (const secret of secrets) assert(!logs.includes(secret), "Synthetic plaintext appeared in the server console");
  const report = { date: new Date().toISOString().slice(0, 10), ok: true, elapsedMs: Date.now() - start, packets: packets.length,
    checks: ["real isolated harness", "official local OPF worker with network disabled", "actual transport has no synthetic plaintext", "history and repeated aliases", "display restoration stays local", "unsupported routes return 403", "WebSocket upgrade refused", "malformed filter configuration sends zero packets", "console contains no synthetic originals"],
    requestedDevice: process.env.OMB_PRIVACY_DEVICE ?? "auto",
    firstTurnMs, secondTurnMs,
    firstPacketBytes: Buffer.byteLength(JSON.stringify(packets[0])), payloads: packets,
    vaultPermissions: "private directory 0700, vault 0600", localConversationContainsOriginals: true };
  await mkdir(join(repo, ".privacy-dev/evidence"), { recursive: true, mode: 0o700 });
  await writeFile(join(repo, ".privacy-dev/evidence/acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, payloads: undefined }, null, 2));
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  await new Promise(resolve => api.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}

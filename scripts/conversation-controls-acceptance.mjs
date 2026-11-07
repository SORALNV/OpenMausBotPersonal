import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verificationServerEnvironment } from "./control-omb.ts";

const repo = process.cwd();
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "omb-cc-"));
const data = join(root, "data");
mkdirSync(data); mkdirSync(join(data, "tmp"));
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const dump = join(data, "turn.json");
const env = { ...verificationServerEnvironment({}, data, port), FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(data, "finish") };
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(repo, "server/testing/fake-claude-cli.ts") } } }, decider: { enabled: false }, newBotDefaults: { profile: { computer: "off", browser: false } } }));
const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
const {Store}=await import('./server/store.ts');const s=new Store(()=>({instanceId:'claude',model:'fixture'}));
const b=s.createBot({name:'Synthetic Controls'});s.patchBot(b.id,{approvalMode:'ask'});s.patchTask(b.id,b.threadId,{approvalMode:'ask'});
const g=s.createGroup('Synthetic ALL',[b.id],false,undefined,{completed:true,defaultResponder:{kind:'bot',botId:b.id}});
const other=s.createTask(b.id,'Unchanged sibling',false); console.log(JSON.stringify({botId:b.id,threadId:b.threadId,groupId:g.id,groupThread:g.threadId,sibling:other.threadId}));
`], { cwd: repo, env, encoding: "utf8" });
assert.equal(seed.status, 0, seed.stderr);
const ids = JSON.parse(seed.stdout.trim());
let child, logs = "";
const out = join(repo, ".privacy-dev/upstream-refresh-20261031"); mkdirSync(out, { recursive: true });
async function until(read, accepts) {
  const end = Date.now() + 45000;
  for (;;) {
    const result = await read(); if (accepts(result)) return result;
    if (Date.now() > end || child?.exitCode !== null) throw Error(`Fixture did not reach the expected state: ${logs.slice(-1000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function start() {
  child = spawn(process.execPath, [resolve(process.argv[2] ?? "dist-server/index.js")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data);
  await until(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, Boolean);
}
async function stop() { if (child?.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; } }
async function api(path, body, token, expected = 200) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(8000), headers: { origin: base, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
const botPath = `/api/bots/${ids.botId}/messages`;
const groupPath = `/api/groups/${ids.groupId}/messages`;
try {
  await start(); await api("/api/auth/session");
  const pairing = await api("/api/auth/pairing", { label: "Synthetic phone", scopes: ["admin", "client"] });
  const paired = await api("/api/auth/pair", { code: pairing.code, label: "Synthetic phone" });
  let token = paired.token;
  const command = async (path, threadId, text, sendId) => api(path, { threadId, text, ...(sendId ? { sendId } : {}) }, token, 202);
  await command(botPath, ids.threadId, "/allow-all", "fixture-command-one");
  await command(botPath, ids.threadId, "/allow-all", "fixture-command-one");
  const messages = (await api(`/api/threads/${ids.threadId}/messages?limit=100`, undefined, token)).messages;
  assert.equal(messages.filter(row => row.sendId === "fixture-command-one").length, 1);
  assert.equal(existsSync(dump), false);
  const bot = (await api("/api/bots?messages=0", undefined, token)).bots.find(bot => bot.id === ids.botId);
  assert.equal(bot.tasks.find(task => task.threadId === ids.threadId).approvalMode, "full");
  assert.equal(bot.tasks.find(task => task.threadId === ids.sibling).approvalMode, "ask");
  await command(botPath, ids.threadId, "/ask");
  await command(groupPath, ids.groupThread, "/allow-all");
  await command(groupPath, ids.groupThread, "/permissions");
  assert.equal(JSON.parse(readFileSync(join(data, "private/conversation-permissions.json"), "utf8"))[ids.groupThread], "full");
  await command(groupPath, ids.groupThread, "Synthetic group permission turn");
  await until(() => existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) : null, Boolean);
  const groupDump = JSON.parse(readFileSync(dump, "utf8"));
  const levelAt = groupDump.argv.indexOf("--permission-mode");
  assert.equal(groupDump.argv[levelAt + 1], "bypassPermissions");
  await api(`/api/groups/${ids.groupId}/interrupt`, { threadId: ids.groupThread }, token);
  rmSync(dump, { force: true });
  await command(botPath, ids.threadId, "Synthetic direct queue turn");
  await until(() => existsSync(dump), Boolean);
  await api(botPath, { threadId: ids.threadId, text: "Queued synthetic follow-up", delivery: "queue" }, token, 202);
  const queuedRows = (await api(`/api/threads/${ids.threadId}/messages?limit=100`, undefined, token)).messages;
  assert.ok(queuedRows.some(row => row.text?.includes("順番待ちに入れました")));
  assert.ok(queuedRows.some(row => row.threadRef?.threadId === ids.threadId && row.tool?.name.includes("待機先")));
  await api(`/api/bots/${ids.botId}/interrupt`, { threadId: ids.threadId }, token);
  await stop(); await start();
  const newPair = await api("/api/auth/pairing", { label: "Synthetic phone again", scopes: ["admin", "client"] });
  const newSession = await api("/api/auth/pair", { code: newPair.code });
  token = newSession.token;
  await command(groupPath, ids.groupThread, "/ask");
  assert.equal(JSON.parse(readFileSync(join(data, "private/conversation-permissions.json"), "utf8"))[ids.groupThread], "ask");
  const report = { isolated: true, compiled: true, pairedAdminCommands: true, idempotent: true, commandsBypassModel: true, directScopePreserved: true, groupFullReachesDriver: true, queuedChatNoticeAndLink: true, survivesRestart: true, revocable: true, nativePhoneUiObserved: false, ok: true };
  assert.ok(newSession.token);
  writeFileSync(join(out, "conversation-controls-acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
} catch (error) { writeFileSync(join(out, "conversation-controls-error.log"), logs, { mode: 0o600 }); throw error; }
finally { await stop(); rmSync(root, { recursive: true, force: true }); }

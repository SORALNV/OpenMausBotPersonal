import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { preparePersonalCodexHome } from "../electron/personal-codex-home.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-codex-isolation-")));
const loginHome = join(root, "shared"), cwd = join(root, "workspace");
mkdirSync(loginHome, { mode: 0o700 }); mkdirSync(cwd);
writeFileSync(join(loginHome, "auth.json"), "{}", { mode: 0o600 });
const cli = process.env.PROBE_CODEX ?? "/opt/homebrew/bin/codex";
const captures = [];
const server = createServer(async (req, res) => {
  if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  captures.push(JSON.parse(raw));
  const item = { id: `msg_${captures.length}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Synthetic remembered code ALPHA.", annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${captures.length}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${captures.length}`, status: "completed", output: [item] } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const args = ["app-server", "-c", 'model_provider="fixture"', "-c", 'model="gpt-6.1-sol"',
  "-c", 'model_providers.fixture.name="Fixture"', "-c", `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
  "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false",
  ...["apps", "plugins", "remote_plugin", "shell_snapshot", "memories", "daemon_auto_start", "browser_use", "computer_use"].flatMap(f => ["-c", `features.${f}=false`]),
];
let child, sequence = 0, pending, completions, phase;
async function start(environment) {
  pending = new Map();
  child = spawn(cli, args, { cwd, env: { PATH: process.env.PATH, HOME: root, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`Native fixture RPC failed: ${message.error.code}`));
      else waiter.resolve(message.result);
    } else if (message.method === "turn/completed") completions?.(message.params);
  });
  await rpc("initialize", { clientInfo: { name: "openmausbot", version: "fixture" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
}
function rpc(method, params) {
  phase = method;
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit"); child.kill("SIGTERM"); await exit;
  }
}
async function turn(threadId, text) {
  const completed = new Promise(resolve => { completions = resolve; });
  await rpc("turn/start", { threadId, input: [{ type: "text", text }] });
  assert.equal((await completed).turn.status, "completed");
}
const timeout = setTimeout(() => {
  console.error(JSON.stringify({ error: "Native fixture timed out", phase }));
  child?.kill("SIGKILL"); server.closeAllConnections(); process.exit(1);
}, 40_000);
try {
  const first = preparePersonalCodexHome({ directory: join(root, "personal"), loginHome });
  const result = spawnSync(cli, ["login", "--with-api-key"], {
    env: { PATH: process.env.PATH, HOME: root, ...first }, input: "sk-SYNTHETIC-ONLY\n", encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0);
  assert(lstatSync(join(first.CODEX_HOME, "auth.json")).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(join(loginHome, "auth.json"), "utf8")).OPENAI_API_KEY, "sk-SYNTHETIC-ONLY");
  const authBefore = readFileSync(join(loginHome, "auth.json"));
  await start(first);
  const { thread } = await rpc("thread/start", { cwd, model: "gpt-6.1-sol", modelProvider: "fixture", historyMode: "paginated", sandbox: "read-only", approvalPolicy: "on-request" });
  await turn(thread.id, "Remember the synthetic code ALPHA.");
  await stop();
  await start(first);
  const resumed = await rpc("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.equal(resumed.thread.id, thread.id);
  await turn(thread.id, "Use the remembered synthetic code.");
  assert(JSON.stringify(captures[1].input).includes("Remember the synthetic code ALPHA."));
  const before = await rpc("thread/turns/list", { threadId: thread.id, itemsView: "full", limit: 100 });
  assert.equal(before.data.length, 2);
  await rpc("thread/archive", { threadId: thread.id });
  const archived = await rpc("thread/read", { threadId: thread.id });
  await stop();
  const second = preparePersonalCodexHome({ directory: join(root, "migrated"), loginHome });
  mkdirSync(join(second.CODEX_HOME, "sessions"));
  copyFileSync(archived.thread.path, join(second.CODEX_HOME, "sessions", basename(archived.thread.path)));
  await start(second);
  const imported = await rpc("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.equal(imported.thread.id, thread.id);
  const after = await rpc("thread/turns/list", { threadId: thread.id, itemsView: "full", limit: 100 });
  assert.deepEqual(after.data.map(t => t.items), before.data.map(t => t.items));
  await turn(thread.id, "Continue after the synthetic migration.");
  assert(JSON.stringify(captures[2].input).includes("Remember the synthetic code ALPHA."));
  await stop();
  await start({ CODEX_HOME: loginHome, CODEX_SQLITE_HOME: loginHome });
  const shared = await rpc("thread/list", { sourceKinds: [], limit: 100 });
  assert.equal(shared.data.length, 0);
  assert.deepEqual(readFileSync(join(loginHome, "auth.json")), authBefore);
  const report = { ok: true, testedAt: new Date().toISOString(), nativeCodex: true, syntheticOnly: true,
    nativeCredentialWriteKeepsLink: true, resumedWithHistory: true, migrationPreservesItems: true,
    sharedThreadCount: shared.data.length, loopbackModelRequests: captures.length };
  const evidence = new URL("../.privacy-dev/evidence/personal-codex-isolation.json", import.meta.url);
  writeFileSync(evidence, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(timeout); await stop(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
}

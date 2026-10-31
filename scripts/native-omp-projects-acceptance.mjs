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
const api = (path, options) => request(path, { ...options, ...(options?.body && typeof options.body !== "string" ? { body: JSON.stringify(options.body) } : {}) }, url);
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
const reportDir = join(repo, ".privacy-dev/pi-project-router-20261030"); mkdirSync(reportDir, { recursive: true });
try {
  await until(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, Boolean);
  const { bot } = await tool("create_bot", { name: "Synthetic Pi Manager" }); const threadId = bot.activeTaskId;
  const selection = { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 10000 };
  const binding = { botId: bot.id, enabled: true, host: "fixture.test", user: "fixture", binary: "/fixture/omp", stateRoot: "/fixture/threads", profile: "fixture", cwd: "/fixture/work", model: "fixture/model", connection: "shared-tui", mediator: selection, formatter: selection };
  await api("/api/native-omp", { method: "PUT", body: { bindings: [binding] } });
  const projects = [];
  for (const name of ["MyShelf", "MyMCP"]) {
    const {session} = await api("/api/native-omp/sessions", { method: "POST", body: { botId: bot.id, threadId, name, requestId: "fixture-project-" + name } });
    projects.push({name, sessionId: session.id, description: name === "MyShelf" ? "本棚・記事検索" : "NAS・MCP連携"});
  }
  await api("/api/native-omp/projects", { method: "PUT", body: { botId: bot.id, threadId, projects } });
  await api("/api/native-omp/threads", { method: "POST", body: { botId: bot.id, threadId, kind: "router" } });
  const messages = () => api(`/api/threads/${threadId}/messages?limit=500`);
  const send = text => tool("send_bot_message", { bot_id: bot.id, task_id: threadId, text });
  await send("両方の架空の読み取りを確認 FIXTURE_PROJECT_CROSS");
  const result = await until(messages, value => value.messages.some(m => m.nativeOmp?.projects?.length === 2 && m.nativeOmp.formatted));
  const reply = result.messages.find(m => m.nativeOmp?.projects?.length === 2 && m.nativeOmp.formatted);
  assert.equal(reply.turnSucceeded, true); assert.deepEqual(reply.nativeOmp.projects.map(r => r.sessionId), projects.map(p => p.sessionId));
  let prompts = calls().filter(c => c.type === "prompt"); assert.equal(prompts.length, 2);
  const second = JSON.parse(prompts[1].message.split("\n").at(-1)); assert.equal(second.previous_results.length, 1); assert.equal(second.previous_results[0].project, "MyShelf");
  const botState = await api("/api/bots?messages=0"); assert.equal(botState.bots.find(b => b.id === bot.id).tasks.length, 1);
  const count = prompts.length;
  await send("FIXTURE_LOCAL_ADVICE 相談だけ"); await until(messages, value => value.messages.some(m => m.text === "相談として説明します。実機は確認していません。")); assert.equal(calls().filter(c => c.type === "prompt").length, count);
  await send("FIXTURE_PROJECT_INVALID");
  await until(messages, value => value.messages.some(m => m.turnTerminal && !m.turnSucceeded && m.text.includes("プロジェクト別")));
  assert.equal(calls().filter(c => c.type === "prompt").length, count);
  await send("FIXTURE_PROJECT_CROSS SYNTHETIC_SELECT_APPROVAL");
  const approved = new Set();
  for (let index = 0; index < 2; index++) {
    const pending = await until(messages, value => value.messages.some(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired && !approved.has(m.card.requestId)));
    const card = pending.messages.find(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired && !approved.has(m.card.requestId)).card;
    approved.add(card.requestId);
    await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: card.requestId, behavior: "allow" } });
  }
  await until(messages, value => value.messages.filter(m => m.nativeOmp?.projects?.length === 2 && m.turnSucceeded).length === 2);
  assert.equal(approved.size, 2);
  const beforeStop = calls().filter(c => c.type === "prompt").length;
  await send("FIXTURE_PROJECT_CROSS SYNTHETIC_HOLD"); await until(async () => calls(), value => value.filter(c => c.type === "prompt").length === beforeStop + 1);
  await api(`/api/bots/${bot.id}/interrupt`, { method: "POST", body: {threadId} });
  await until(messages, value => value.messages.some(m => m.requestCancelled));
  assert.equal(calls().filter(c => c.type === "prompt").length, beforeStop + 1);
  const state = await api("/api/native-omp"); assert.equal(state.threadModes[threadId], "router");
  assert.deepEqual((await api(`/api/native-omp/projects?botId=${bot.id}&threadId=${threadId}`)).projects, projects);
  const report = { isolatedServer:true, realHttpRoutes:true, syntheticMediator:true, syntheticNativePeer:true, orderedExistingSessionRouting:true, previousResultsHandedOff:true, nativeOriginalsRetained:true, visibleThreadCount:1, adviceNotForwarded:true, invalidTargetNotSent:true, stopPreventsLaterStage:true, perStepApprovalsPreserved:true, privateSettingsPersisted:true, ok:true };
  writeFileSync(join(reportDir, "http-acceptance.json"), JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
} catch(error) { writeFileSync(join(reportDir, "http-error.log"), logs); throw error; }
finally { if(child.exitCode === null) { const done = once(child,"exit");child.kill("SIGTERM");await done; }rmSync(root,{recursive:true,force:true}); }

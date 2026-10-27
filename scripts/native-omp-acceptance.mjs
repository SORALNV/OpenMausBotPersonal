import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationServerEnvironment } from "./control-omb.ts";
import { request, handleToolCall } from "./mcp-server.ts";
import { formatQuestionAnswers } from "../shared/ask-question.ts";

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
let ownerToken;
const api = (path, options) => request(path, { ...options, ...(options?.body && typeof options.body !== "string" ? { body: JSON.stringify(options.body) } : {}), ...(ownerToken ? { headers: { ...options?.headers, authorization: `Bearer ${ownerToken}` } } : {}) }, url);
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
  const messages = (thread = threadId) => api(`/api/threads/${thread}/messages?limit=500`);
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
  assert.equal(question.card.tool, undefined);
  assert.equal(question.card.subtitle, "架空の項目を選んでください");
  assert.deepEqual(question.card.options, ["アルファ", "ベータ"]);
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: question.card.requestId, behavior: "answer", message: formatQuestionAnswers(question.card.questionRequest.questions, [["ベータ"]]) } });
  await settled(6); assert.ok(calls().some(call => call.type === "extension_ui_response" && call.value === "Beta"));

  await send("SYNTHETIC_SELECT_APPROVAL");
  const selectState = await until(messages, value => value.messages.some(message => message.card?.requestType === "permission" && !message.card.answered && !message.card.expired));
  const select = selectState.messages.find(message => message.card?.requestType === "permission" && !message.card.answered && !message.card.expired);
  assert.deepEqual(select.card.options, ["許可", "拒否"]);
  assert.ok(select.card.subtitle.endsWith("ツール「write」の実行許可\n対象: /fixture/synthetic.txt"));
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
  const sharedMessages=()=>api(`/api/threads/${shared.activeTaskId}/messages?limit=100`);
  await tool("send_bot_message",{bot_id:shared.id,task_id:shared.activeTaskId,text:"SYNTHETIC_HOLD"});
  await until(()=>api("/api/bots?messages=0"),value=>value.bots.find(b=>b.id===shared.id)?.tasks.find(t=>t.threadId===shared.activeTaskId)?.nativeOmpStatus?.canSteer===true);
  const promptsBeforeSteer=calls().filter(c=>c.type==="prompt").length;
  const injection=await api(`/api/bots/${shared.id}/messages`,{method:"POST",body:{threadId:shared.activeTaskId,text:"実行中の架空追加入力",delivery:"steer",sendId:"fixture-native-steer-0001"}});
  assert.equal(injection.steered,true);
  await until(sharedMessages,value=>value.messages.some(m=>m.turnTerminal&&m.nativeOmp?.originalText.includes("実行中の架空追加入力")));
  const duplicateSteer=await api(`/api/bots/${shared.id}/messages`,{method:"POST",body:{threadId:shared.activeTaskId,text:"実行中の架空追加入力",delivery:"steer",sendId:"fixture-native-steer-0001"}});
  assert.equal(duplicateSteer.message.id,injection.message.id);
  assert.equal(calls().filter(c=>c.type==="steer").length,1);
  assert.equal(calls().filter(c=>c.type==="prompt").length,promptsBeforeSteer);
  await tool("send_bot_message",{bot_id:shared.id,task_id:shared.activeTaskId,text:"SYNTHETIC_HOLD queue fixture"});
  await until(()=>api("/api/bots?messages=0"),value=>value.bots.find(b=>b.id===shared.id)?.tasks.find(t=>t.threadId===shared.activeTaskId)?.nativeOmpStatus?.canSteer===true);
  const heldA=await api(`/api/bots/${shared.id}/messages`,{method:"POST",body:{threadId:shared.activeTaskId,text:"キュー入力A",delivery:"queue",sendId:"fixture-native-queue-0001"}});
  const heldB=await api(`/api/bots/${shared.id}/messages`,{method:"POST",body:{threadId:shared.activeTaskId,text:"キュー入力B",delivery:"queue",sendId:"fixture-native-queue-0002"}});
  assert.equal(heldA.queued,true);assert.equal(heldB.queued,true);
  const moved=await api(`/api/bots/${shared.id}/queue/${heldA.queueId}/steer`,{method:"POST",body:{threadId:shared.activeTaskId}});
  assert.equal(moved.steered,true);assert.equal(moved.messages.length,2);
  assert.deepEqual(moved.messages.map(m=>m.sendId),["fixture-native-queue-0001","fixture-native-queue-0002"]);
  assert.deepEqual(moved.queueIds,[heldA.queueId,heldB.queueId]);
  await until(sharedMessages,value=>value.messages.some(m=>m.turnTerminal&&m.nativeOmp?.originalText.includes("キュー入力A\n\nキュー入力B")));
  assert.equal(calls().filter(c=>c.type==="steer").length,2);
  const beforeReview = (await messages()).messages.filter(m => m.nativeOmp?.formatted).length;
  await api("/api/native-omp", { method: "PUT", body: { bindings: [{ ...binding, approvalPolicy: "mediator" }, sharedBinding] } });
  const cardsBefore = (await messages()).messages.filter(m => m.card?.requestType === "permission").length;
  await send("SYNTHETIC_REVIEW_INSPECTION"); await settled(beforeReview + 1);
  assert.equal((await messages()).messages.filter(m => m.card?.requestType === "permission").length, cardsBefore);
  const inspected = (await messages()).messages;
  const inspectionRequest = inspected.find(m => m.role === "user" && m.text?.includes("SYNTHETIC_REVIEW_INSPECTION"));
  assert.ok(inspected.some(m => m.requestMessageId === inspectionRequest.id && m.kind === "text" && m.text?.includes("Pi / OhMyPi に依頼中")));
  const responseCount = calls().filter(c => c.type === "extension_ui_response").length;
  await send("SYNTHETIC_REVIEW_IMPORTANT");
  const importantState = await until(messages, value => value.messages.some(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired));
  assert.equal(calls().filter(c => c.type === "extension_ui_response").length, responseCount);
  const important = importantState.messages.find(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired);
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: important.card.requestId, behavior: "deny" } });
  await settled(beforeReview + 2);
  await send("SYNTHETIC_REPORT"); await settled(beforeReview + 3);
  assert.ok(calls().some(call => call.type === "extension_ui_response" && call.id === "fixture-report" && call.value === "No"));
  assert.ok(!(await messages()).messages.some(m => m.card?.subtitle?.includes("haunted")));
  const developmentCards = (await messages()).messages.filter(m => m.card?.requestType === "permission").length;
  for (const [index, mode] of ["PROJECT", "TEST", "LOOKUP", "SMOKE", "EDIT", "CONFIG", "STATUS", "DIAGNOSTIC"].entries()) {
    await send(`架空の開発とローカルテスト。SYNTHETIC_REVIEW_${mode}`); await settled(beforeReview + 4 + index);
  }
  assert.equal((await messages()).messages.filter(m => m.card?.requestType === "permission").length, developmentCards);
  for (const id of ["fixture-project", "fixture-test", "fixture-lookup", "fixture-smoke", "fixture-edit", "fixture-config", "fixture-status", "fixture-diagnostic"]) assert.equal(calls().filter(call => call.type === "extension_ui_response" && call.id === id && call.value === "Approve").length, 1);
  const openedPairing = await api("/api/auth/pairing", { method: "POST", body: {} });
  const pairedOwner = await api("/api/auth/pair", { method: "POST", body: { code: openedPairing.code } });
  ownerToken = pairedOwner.token;
  assert.ok(ownerToken);
  const consentBefore = (await messages()).messages.filter(m => m.nativeOmp?.formatted).length;
  await send("SYNTHETIC_REVIEW_IMPORTANT");
  await until(messages, value => value.messages.some(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired));
  const promptsBeforeConsent = calls().filter(call => call.type === "prompt").length;
  await send("すべて許可");
  await settled(consentBefore + 1);
  const auditState = await until(messages, value => value.messages.some(m => m.card?.requestId?.startsWith("native-omp-audit-") && m.card.subtitle.includes("正常終了を確認")));
  const audit = auditState.messages.find(m => m.card?.requestId?.startsWith("native-omp-audit-"));
  assert.equal(audit.card.answered, "allow");
  assert.equal(audit.turnId, undefined);
  assert.ok(audit.card.subtitle.includes("mkfs.ext4 /dev/sda"));
  assert.equal(calls().filter(call => call.type === "prompt").length, promptsBeforeConsent);
  assert.ok(!calls().some(call => call.value?.includes("for this session")));
  await send("SYNTHETIC_REVIEW_IMPORTANT");
  const afterConsent = await until(messages, value => value.messages.some(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired));
  const pendingAgain = afterConsent.messages.find(m => m.card?.requestType === "permission" && !m.card.answered && !m.card.expired);
  await api(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: pendingAgain.card.requestId, behavior: "deny" } });
  await settled(consentBefore + 2);
  const beforeLocal = calls().filter(call => call.type === "prompt").length;
  await send("実行せず設計を相談したい。FIXTURE_LOCAL_ADVICE");
  const localAdvice = await until(messages, value => value.messages.some(m => m.text === "相談として説明します。実機は確認していません。" && m.turnTerminal));
  assert.ok(localAdvice.messages.some(m => m.text === "相談として説明します。実機は確認していません。" && !m.nativeOmp));
  assert.equal(calls().filter(call => call.type === "prompt").length, beforeLocal);
  await send("OMBの定期実行設定を確認して。FIXTURE_OMB_LOCAL");
  const localSettings = await until(messages, value => {
    const source = value.messages.find(m => m.role === "user" && m.text?.includes("FIXTURE_OMB_LOCAL"));
    return source && value.messages.some(m => m.requestMessageId === source.id && m.turnTerminal);
  });
  const localSource = localSettings.messages.find(m => m.role === "user" && m.text?.includes("FIXTURE_OMB_LOCAL"));
  const localFinal = localSettings.messages.find(m => m.requestMessageId === localSource.id && m.turnTerminal);
  assert.equal(localFinal.turnSucceeded, true, localFinal.text);
  assert.equal(calls().filter(call => call.type === "prompt").length, beforeLocal);
  assert.equal(localSettings.messages.filter(m => m.role === "user" && m.text?.includes("FIXTURE_OMB_LOCAL")).length, 1);
  assert.ok(localSettings.messages.some(m => m.tool?.name === "OMB/list_triggers" && m.tool.ok));
  await until(() => api("/api/bots?messages=0"), value => !value.bots.find(b => b.id === bot.id).tasks.find(t => t.threadId === threadId).busy);
  await send("OMB側のこのBotの説明を架空のNAS管理担当へ変えて。FIXTURE_OMB_PROFILE");
  const profileState = await until(messages, value => value.messages.some(m => m.card?.profileRequest && m.card.answered === "allow"));
  assert.ok(profileState.messages.some(m => m.card?.profileRequest && m.card.autoApplied));
  assert.equal((await api("/api/bots?messages=0")).bots.find(b => b.id === bot.id).description, "架空のNAS管理担当");
  await until(messages, value => value.messages.some(m => m.role === "user" && m.text?.includes("FIXTURE_OMB_PROFILE") && !m.requestPending));
  assert.equal(calls().filter(call => call.type === "prompt").length, beforeLocal);
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T1IAAAAASUVORK5CYII=", "base64");
  const uploadResponse = await fetch(url + "/api/attachments", { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${ownerToken}` }, body: imageBytes });
  assert.equal(uploadResponse.status, 201); const upload = await uploadResponse.json();
  const imagePrompt = `添付画像をPiの作業に使って。SYNTHETIC_IMAGE\n\n<attached-image path="${upload.path}" />`;
  await send(imagePrompt);
  await until(messages, value => value.messages.some(m => m.nativeOmp?.originalText?.includes("SYNTHETIC_IMAGE") && m.nativeOmp.formatted));
  const imageCall = calls().find(call => call.type === "prompt" && call.message?.includes("SYNTHETIC_IMAGE"));
  assert.deepEqual(imageCall.images, [{ type: "image", mimeType: "image/png", data: imageBytes.toString("base64") }]);
  assert.ok(!imageCall.message.includes(upload.path));
  assert.ok((await messages()).messages.some(m => m.role === "user" && m.text === imagePrompt));
  const promptsBeforeImageAdvice = calls().filter(call => call.type === "prompt").length;
  const imageAdvice = `画像の相談だけです。FIXTURE_LOCAL_ADVICE\n\n<attached-image path="${upload.path}" />`;
  await send(imageAdvice);
  await until(messages, value => value.messages.some(m => m.role === "user" && m.text === imageAdvice && !m.requestPending));
  assert.equal(calls().filter(call => call.type === "prompt").length, promptsBeforeImageAdvice);
  const created = await api("/api/native-omp/sessions", { method: "POST", body: { botId: bot.id, threadId, name: "架空のUIプロジェクト", requestId: "fixture-ui-project" } });
  const duplicate = await api("/api/native-omp/sessions", { method: "POST", body: { botId: bot.id, threadId, name: "架空のUIプロジェクト", requestId: "fixture-ui-project" } });
  assert.equal(created.session.id, duplicate.session.id);
  await api("/api/native-omp/threads", { method: "POST", body: { botId: bot.id, threadId: secondThread, sessionId: created.session.id, kind: "session" } });
  await tool("send_bot_message", { bot_id: bot.id, task_id: secondThread, text: "選択した既存セッションへの架空入力" });
  const selected = await until(() => messages(secondThread), value => value.messages.some(m => m.nativeOmp?.sessionId === created.session.id && m.nativeOmp?.formatted));
  assert.ok(selected.messages.some(m => m.nativeOmp?.sessionId === created.session.id && m.nativeOmp.originalText.includes("選択した既存セッションへの架空入力")));
  const promptsBeforeManagement = calls().filter(call => call.type === "prompt").length;
  await send("研究用のセッションを作り、新しいThreadsへ接続してください。FIXTURE_CREATE_AND_LINK");
  await until(messages, value => value.messages.some(m => m.turnSucceeded && m.text?.includes("架空の研究プロジェクト") && m.text.includes("接続しました")));
  const managedState = await api("/api/native-omp");
  const newLink = Object.entries(managedState.threadTargets).find(([, value]) => value.session.name === "架空の研究プロジェクト");
  assert.ok(newLink); assert.notEqual(newLink[0], threadId);
  assert.equal(calls().filter(call => call.type === "prompt").length, promptsBeforeManagement);
  await tool("send_bot_message", { bot_id: bot.id, task_id: newLink[0], text: "名前付き新規セッションの架空入力" });
  await until(() => messages(newLink[0]), value => value.messages.some(m => m.nativeOmp?.sessionId === newLink[1].session.id && m.nativeOmp.formatted));
  const taskCount = (await api("/api/bots?messages=0")).bots.find(b => b.id === bot.id).tasks.length;
  await send("保存だけするセッションを作って。新しいスレッドは不要です。FIXTURE_CREATE_ONLY");
  await until(messages, value => value.messages.some(m => m.turnSucceeded && m.text?.includes("架空の保存専用") && m.text.includes("接続先は変更していません")));
  assert.equal((await api("/api/bots?messages=0")).bots.find(b => b.id === bot.id).tasks.length, taskCount);
  const beforeMalformed = calls().filter(call => call.type === "prompt").length;
  await send("新しいセッションを作成して。FIXTURE_BAD_SESSION_PLAN");
  await until(messages, value => value.messages.some(m => m.role === "user" && m.text?.includes("FIXTURE_BAD_SESSION_PLAN") && !m.requestPending));
  assert.equal(calls().filter(call => call.type === "prompt").length, beforeMalformed);
  assert.ok(!calls().some(call => call.type === "prompt" && call.message?.includes("FIXTURE_CREATE_AND_LINK")));
  await send("SYNTHETIC_PROGRESS");
  const liveProgress = await until(messages, value => value.messages.some(message => message.text?.includes("架空の設定を確認しました。続いてテストします。") && message.turnId && !message.turnTerminal));
  const progressLine = liveProgress.messages.find(message => message.text?.includes("架空の設定を確認しました。続いてテストします。"));
  assert.ok(liveProgress.messages.some(message => message.requestMessageId === progressLine.requestMessageId && message.text?.includes("Pi / OhMyPi に依頼中")));
  assert.ok(!liveProgress.messages.some(message => message.requestMessageId === progressLine.requestMessageId && message.turnTerminal));
  const progressDone = await until(messages, value => value.messages.some(message => message.requestMessageId === progressLine.requestMessageId && message.turnTerminal));
  const terminal = progressDone.messages.find(message => message.requestMessageId === progressLine.requestMessageId && message.turnTerminal);
  assert.equal(terminal.turnId, progressLine.turnId);
  assert.ok(!terminal.nativeOmp.originalText.includes("架空の設定を確認しました"));
  assert.ok(!JSON.stringify(progressDone).includes("SYNTHETIC_PRIVATE_REASONING"));
  const report = { ok: true, isolatedHome: true, syntheticNativePeer: true, independentMediator: true, originalInputPreserved: true, nativeAnswerPreserved: true, shortDisplayOnly: true,
    nativeSessionResumed: true, separateNativeSessionPerThread: true, queuedInputsSeparate: true, humanApprovalBeforeTool: true, nativeSelectApprovalOnceOnly: true, humanQuestionsRelayed: true, nativeStopDispatched: true, nativeFailureNotSuccess: true, unrelatedBotUnchanged: true, sharedConnectorExactText: true, sharedConnectorRepeatedTurns: true, nativeSteerAdmission: true, nativeSteerSendIdempotent: true, nativeQueuedSteerRetainsInputs: true, mediatorInspectionApproval: true, importantOperationStillNeedsHuman: true,
    namedSessionIdempotent: true, existingSessionSelected: true, chatCreatedSessionAndThread: true, newThreadNativeRoundTrip: true, saveOnlyCreatesNoThread: true, malformedManagementNeverForwarded: true,
    mediatorProjectSave: true, mediatorUnittestWithSavedSource: true, mediatorCommandLookup: true, mediatorSmokeWithExactSavedSource: true, mediatorNativeEdit: true, mediatorProjectConfig: true, mediatorLocalApi: true, mediatorPythonDiagnostic: true, noDevelopmentApprovalCards: true, nativeUploadedImageBytesVerified: true, imageConsultationWithoutNative: true, consultationAnsweredWithoutNative: true, ombSettingsUseLocalHarness: true, ombProfileUsesExistingApplyPolicy: true, localNativeExecutionExcluded: true, explicitOwnerConsentWhileBusy: true, highRiskExecutionReceipt: true, consentExpiresAtCompletion: true, noSessionWideGrant: true, nativeProgressBeforeFinal: true, nativeProgressSharesFinalTurn: true, privateThinkingExcluded: true, testedAt: new Date().toISOString() };
  writeFileSync(join(reportDir, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
} catch (error) {
  writeFileSync(join(reportDir, "fixture-error.log"), logs, { mode: 0o600 });
  try {
    const state = await api("/api/native-omp");
    const bots = await api("/api/bots?messages=0");
    const history = await Promise.all(bots.bots.map(bot => api(`/api/threads/${bot.threadId}/messages?limit=50`)));
    writeFileSync(join(reportDir, "fixture-error.json"), JSON.stringify({ state, history, calls: calls() }, null, 2), { mode: 0o600 });
  } catch { /* A crashed fixture may not answer diagnostics. */ }
  throw error;
} finally {
  const exited = once(child, "exit"); if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
  rmSync(root, { recursive: true, force: true });
}

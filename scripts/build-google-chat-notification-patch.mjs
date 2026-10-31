import { readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { build } from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const target = await realpath(process.argv[2] ?? "");
const allowed = await realpath(resolve(repo, ".privacy-dev/personal-build"));
if (!target.startsWith(allowed + sep) || !target.endsWith(".app/Contents/Resources/server/index.js")) throw Error("Select a staged Personal runtime");
const original = await readFile(target, "utf8");
if (original.includes('./google-chat-notifications.js')) throw Error("Runtime already patched");
const tree = ts.createSourceFile("runtime.js", original, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
let installedClass, dependencies, routeRegistration;
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "GoogleChatLink" && node.initializer && ts.isClassExpression(node.initializer)) installedClass = node.initializer;
  if (ts.isNewExpression(node) && node.expression.getText(tree) === "GoogleChatLink" && node.arguments?.length === 2 && ts.isObjectLiteralExpression(node.arguments[1])) dependencies = node.arguments[1];
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "ROUTES.push" && node.arguments.length === 1 && node.arguments[0].getText(tree) === "googleChat.route") routeRegistration = node.arguments[0];
  ts.forEachChild(node, visit);
};
visit(tree);
if (!installedClass || !dependencies) throw Error("Google Chat integration shape not found");
const names = dependencies.properties.map(node => node.name?.getText(tree));
for (const name of ["post", "attention", "mask", "maskResult", "hasEvent"]) if (!names.includes(name)) throw Error("Runtime dependency missing: " + name);
const base = dependencies.properties.filter(node => !["post", "attention"].includes(node.name?.getText(tree))).map(node => node.getText(tree));
base.push(`classify: async (botId, _threadId, input, signal) => {
  const generator = sideJobs.text("google-chat", botId);
  if (!generator) throw new Error("Google Chat notification model is unavailable");
  return GoogleChatNotifications.classifyGoogleChatNotification(input, generator.generateText, { signal, timeoutMs: 120000 });
}`);
base.push('selfName: () => cfg.profile?.name?.trim() ?? ""', 'timeZone: routineTimeZone');
base.push(`report: async (botId, threadId, text, eventId) => {
  const bot = store.bot(botId);
  if (!bot || !store.taskByThread(botId, threadId)) throw new Error("Google Chat target is unavailable");
  store.appendMessage(threadId, { role: "bot", kind: "text", text, webhookPost: true, googleChatEventId: eventId });
  store.patchTask(botId, threadId, { unread: true });
  notify({ kind: "done", botId, botName: bot.name, threadId, title: "Google Chat", body: text });
}`);
base.push(`attention: (botId, threadId, status) => {
  if (status === "CONNECTED") return;
  const reasons = { LOGIN_REQUIRED: "大学アカウントの再ログインが必要です", CLASSIFIER_TIMEOUT: "通知判定の応答期限を超えました。投稿は未処理で保持しています", CLASSIFIER_FAILED: "通知判定に失敗しました。投稿は未処理で保持しています", MASK_TIMEOUT: "登録語句の置換が応答期限を超えました", MASK_FAILED: "登録語句の置換に失敗しました", CONTEXT_TIMEOUT: "スレッド確認が応答期限を超えました", CONTEXT_FAILED: "スレッドを確認できません", QUEUE_FAILED: "通知の保存に失敗しました", COLLECTOR_STALE: "収集更新が途絶えています", BROWSER_OFFLINE: "管理ブラウザが停止しています", FEED_CONNECTION: "監視サーバーに接続できません", CURSOR_RESET: "受信位置の確認が必要です", STORAGE_FAILED: "処理履歴を保存できません" };
  const text = status === "OK" ? "Google Chatの監視接続が復旧しました。通知は連絡管理人が必要性を判定します。" : "Google Chat監視に確認が必要です（" + status + "）。" + (reasons[status] ?? "受信を確認できません") + "。";
  store.appendMessage(threadId, { role: "bot", kind: "text", text, webhookPost: true });
  const bot = store.bot(botId);
  if (bot) notify({ kind: status === "OK" ? "done" : "incident", botId, botName: bot.name, threadId, title: "Google Chat監視", body: text });
}`);
const edits = [
  { start: installedClass.getStart(tree), end: installedClass.end, text: "GoogleChatNotifications.GoogleChatLink" },
  { start: dependencies.getStart(tree), end: dependencies.end, text: "{\n" + base.join(",\n") + "\n}" },
];
if (routeRegistration) edits.push({ start: routeRegistration.getStart(tree), end: routeRegistration.end, text: `(context) => {
  if (!["/api/google-chat", "/api/google-chat/connect", "/api/google-chat/check"].includes(context.path) || !["GET", "PUT", "POST"].includes(context.method)) return Promise.resolve(PASS);
  return googleChat.route(context);
}` });
else if (!original.includes("scopeGoogleChatRoute(googleChat.route)")) throw Error("Google Chat host route boundary not found");
let output = original;
for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
output = 'import * as GoogleChatNotifications from "./google-chat-notifications.js";\n' + output;
await build({ entryPoints: [resolve(repo, "server/google-chat-runtime.ts")], outfile: resolve(dirname(target), "google-chat-notifications.js"), bundle: true, format: "esm", platform: "node", target: "node22", sourcemap: false });
await writeFile(target, output);
const digest = value => createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({ target, originalSha256: digest(original), patchedSha256: digest(output), notificationModule: "google-chat-notifications.js" }));

import { readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const repo = fileURLToPath(new URL("../", import.meta.url));
const target = await realpath(process.argv[2] ?? "");
const allowed = await realpath(resolve(repo, ".privacy-dev/personal-build"));
if (!target.startsWith(allowed + sep) || !target.endsWith(".app/Contents/Resources/server/index.js")) throw Error("Select a staged Personal app, never the installed app");
const original = await readFile(target, "utf8");
const source = await readFile(resolve(repo, "server/google-chat.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const ast = (text, name) => ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
const before = ast(original, "installed.js"), after = ast(compiled, "source.js");
function classNode(tree) {
  let result;
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === "GoogleChatLink") result = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "GoogleChatLink" && node.initializer && ts.isClassExpression(node.initializer)) result = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree); if (!result) throw Error("Google Chat class not found"); return result;
}
const installedClass = classNode(before), sourceClass = classNode(after);
const methods = ["status", "configure", "start", "notice", "verifyMonitor", "check"];
const edits = [];
for (const name of methods) {
  const next = sourceClass.members.find(member => member.name?.getText(after) === name);
  const current = installedClass.members.find(member => member.name?.getText(before) === name);
  if (!next || !ts.isMethodDeclaration(next)) throw Error("Source method missing: " + name);
  if (current) edits.push({ start: current.getStart(before), end: current.end, text: next.getText(after) });
  else if (name === "verifyMonitor") edits.push({ start: installedClass.members[0].getStart(before), end: installedClass.members[0].getStart(before), text: next.getText(after) + "\n" });
  else throw Error("Installed method missing: " + name);
}
let codes;
const findCodes = node => { if (ts.isVariableDeclaration(node) && node.name.getText(before) === "CHAT_CODES") codes = node.initializer; ts.forEachChild(node, findCodes); };
findCodes(before);
if (!codes || !ts.isArrayLiteralExpression(codes) || codes.elements.some(item => !ts.isStringLiteral(item))) throw Error("Diagnostic code table not found");
const values = codes.elements.map(item => item.text);
edits.push({ start: codes.getStart(before), end: codes.end, text: JSON.stringify([...new Set([...values, "MONITOR_NOT_READY"])]) });
let output = original;
for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
await writeFile(target, output);
const ui = resolve(dirname(target), "../ui/assets");
const labels = new Map([
  ["Google Chatを接続", "通知先を登録・状態確認"],
  ["監視接続: ", "通知先登録済み／監視状態: "],
  ["接続情報はMac内で読み込み、画面やAIには渡しません。停止するとこのボットへの新着受信とGoogle Chatツールの組込みを止めます。", "通知先の登録は監視成功を意味しません。再ログイン要求中は新着を受信できません。接続情報はMac内で読み込み、画面やAIには渡しません。"],
]);
const uiAssets = [];
for (const name of (await readdir(ui)).filter(name => /^SettingsModal-.*\.js$/.test(name))) {
  const path = resolve(ui, name), text = await readFile(path, "utf8"), tree = ast(text, name), changes = [];
  const visit = node => {
    if (ts.isStringLiteral(node) && labels.has(node.text)) changes.push({ start: node.getStart(tree), end: node.end, text: JSON.stringify(labels.get(node.text)) });
    if (ts.isTemplateHead(node) && labels.has(node.text)) changes.push({ start: node.getStart(tree) + 1, end: node.end - 2, text: labels.get(node.text) });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!changes.length) continue;
  if (changes.length !== labels.size) throw Error("Unexpected settings label layout");
  let changed = text;
  for (const edit of changes.sort((a, b) => b.start - a.start)) changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
  await writeFile(path, changed); uiAssets.push(name);
}
if (!uiAssets.length) throw Error("Google Chat settings asset not found");
const sha = value => createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({ target, methods, uiAssets, originalSha256: sha(original), patchedSha256: sha(output), sourceSha256: sha(source) }));

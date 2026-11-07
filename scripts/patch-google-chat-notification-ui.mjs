import { readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = fileURLToPath(new URL("../", import.meta.url));
const target = await realpath(process.argv[2] ?? "");
const allowed = await realpath(resolve(repo, ".privacy-dev/personal-build"));
if (!target.startsWith(allowed + sep) || !target.endsWith(".app/Contents/Resources/ui/assets")) throw Error("Select staged runtime UI assets");
const labels = new Map([
  ["監視専用ブラウザの新着を受け取り、返信を頼んだときだけ送信します。", "連絡管理人が新たな対応の必要性を判定し、必要なときだけ短く通知します。"],
  ["対象は監視サーバーに登録したスレッドだけです。取得本文は登録語句だけをこのMacで置換します。未登録の個人情報は自動検出しません。受信だけでAIや返信を起動しません。", "対象は監視サーバーに登録したスレッドだけです。本文はこのMacで登録語句を置換してから、連絡管理人の通知判定へ渡します。本人に新たな返信・判断・予定確認が必要なときだけ短く知らせます。全文転送やGoogle Chatへの自動返信は行いません。未登録の個人情報は自動検出しません。"],
  ["予定管理人", "連絡管理人"],
]);
let changed = 0;
for (const name of (await readdir(target)).filter(name => /^SettingsModal-.*\.js$/.test(name))) {
  const file = resolve(target, name), source = await readFile(file, "utf8");
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS), edits = [];
  const visit = node => {
    if (ts.isStringLiteral(node) && labels.has(node.text)) edits.push({ start: node.getStart(tree), end: node.end, text: JSON.stringify(labels.get(node.text)) });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (edits.length !== labels.size) throw Error("Unexpected Google Chat settings labels");
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  await writeFile(file, output); changed += edits.length;
}
if (changed !== labels.size) throw Error("Google Chat settings asset not found");
console.log(JSON.stringify({ changedLabels: changed }));

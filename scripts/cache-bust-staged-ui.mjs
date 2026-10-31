import { readdir, readFile, writeFile, realpath, rename } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(process.argv[2] ?? "");
const allowed = await realpath(resolve(repo, ".privacy-dev/personal-build"));
if (!root.startsWith(allowed + sep) || !root.endsWith(".app/Contents/Resources/ui")) throw Error("Select a staged app UI");
const assets = resolve(root, "assets"), tag = randomUUID().slice(0, 8);
const names = (await readdir(assets)).filter(name => name.endsWith(".js"));
const mapping = new Map(names.map(name => [name, name.slice(0, -3) + `-chatfix-${tag}.js`]));
const pattern = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
for (const file of [resolve(root, "index.html"), ...names.map(name => resolve(assets, name))]) {
  const content = await readFile(file, "utf8");
  await writeFile(file, content.replace(pattern, name => mapping.get(name)));
}
for (const [before, after] of mapping) await rename(resolve(assets, before), resolve(assets, after));
console.log(JSON.stringify({ tag, javascriptAssets: names.length, ui: root }));

import { createRequire } from "node:module";
import { app, dialog } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPersonalRuntime } from "./personal-runtime-verifier.mjs";

try {
  const { fingerprint } = JSON.parse(readFileSync(new URL("../personal-launcher.json", import.meta.url), "utf8"));
  const runtime = await verifyPersonalRuntime({ root: join(app.getPath("home"), ".openmausbot-personal", "runtime"), fingerprint, fileSystem: createRequire(import.meta.url)("original-fs") });
  globalThis[Symbol.for("omb.verifiedRuntimeResources")] = runtime.resources;
  await import(pathToFileURL(runtime.entry).href);
} catch (error) {
  console.error("Personal runtime verification/startup failed", error.message);
  const fail = () => {
    dialog.showErrorBox("OpenMausBot Personal を起動できません", "更新データの署名確認または起動に失敗しました。未検証のコードは起動しません。ローカルのバックアップから復元してください。");
    app.exit(1);
  };
  if (app.isReady()) fail(); else app.once("ready", fail);
}

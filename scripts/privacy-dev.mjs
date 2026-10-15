import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { privacyPorts } from "./privacy-ports.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const ports = privacyPorts(process.env);
const root = join(repo, ".privacy-dev");
const data = join(root, "data");
for (const path of [root, data, join(data, "private"), join(root, "home")]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== resolve(path)) throw new Error("Privacy development folders must not be symlinks");
  chmodSync(path, 0o700);
}
const config = join(data, "config.json");
if (!existsSync(config)) writeFileSync(config, JSON.stringify({
  instances: { "privacy-api": { driver: "openai-compat", displayName: "ローカル保護 API", config: {
    url: process.env.OMB_PRIVACY_API_URL ?? "https://openrouter.ai/api/v1",
    apiKeyEnv: "OMB_PRIVACY_API_KEY", model: process.env.OMB_PRIVACY_MODEL ?? "meta-llama/llama-3.3-70b-instruct", tools: false,
  } } },
  decider: { enabled: false },
}, null, 2), { mode: 0o600, flag: "wx" });
const terms = join(data, "private", "terms.json");
if (!existsSync(terms)) writeFileSync(terms, "[]\n", { mode: 0o600, flag: "wx" });
const saved = JSON.parse(readFileSync(config, "utf8"));
if (Object.values(saved.instances ?? {}).some(i => i.driver !== "openai-compat") || saved.mcpServers || saved.routines || saved.cloudHome || saved.decider?.enabled) throw new Error("Privacy development configuration contains an unsupported service");
const env = {
  PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "ja_JP.UTF-8",
  HOME: join(root, "home"), USERPROFILE: join(root, "home"),
  OMB_DATA_DIR: data, OMB_PRIVACY_DEV_ROOT: root, OMB_PRIVACY_MODE: "strict", VITE_OMB_PRIVACY_STRICT: "1",
  ...ports,
  OMB_PRIVACY_PYTHON: join(root, "venv", "bin", "python"),
  OMB_PRIVACY_WORKER: join(repo, "scripts", "privacy-worker.py"),
  OMB_PRIVACY_DEVICE: process.env.OMB_PRIVACY_DEVICE ?? "auto",
  ...(process.env.OMB_PRIVACY_APP_TOKEN ? { OMB_PRIVACY_APP_TOKEN: process.env.OMB_PRIVACY_APP_TOKEN } : {}),
  OMB_PRIVACY_CHECKPOINT: join(root, "checkpoint", "original"),
  TIKTOKEN_CACHE_DIR: join(root, "tiktoken"),
  ...(process.env.OMB_PRIVACY_API_KEY ? { OMB_PRIVACY_API_KEY: process.env.OMB_PRIVACY_API_KEY } : {}),
};
if (!["auto", "cpu", "mps"].includes(env.OMB_PRIVACY_DEVICE)) throw new Error("OMB_PRIVACY_DEVICE must be auto, cpu or mps");
for (const port of [env.OMB_PORT, ...(process.argv.includes("--server-only") ? [] : [env.OMB_UI_PORT])]) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("Privacy development port is occupied; no UI was started")));
    probe.listen(Number(port), "127.0.0.1", () => probe.close(resolve));
  });
}
const children = [];
const stop = () => { for (const child of children) child.kill("SIGTERM"); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const start = (args) => {
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: "inherit" });
  children.push(child);
  child.once("exit", code => { stop(); process.exitCode = code ?? 1; });
  return child;
};
console.log(`Privacy development: http://127.0.0.1:${env.OMB_UI_PORT} (strict; tools, CLI, voice and media disabled)`);
start(["--import", "./server/privacy/preload.ts", "server/index.ts"]);
if (!process.argv.includes("--server-only")) start(["node_modules/vite/bin/vite.js", "--strictPort"]);

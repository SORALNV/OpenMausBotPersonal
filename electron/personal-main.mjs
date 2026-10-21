import { app } from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePersonalCodexHome } from "./personal-codex-home.mjs";

const metadata = JSON.parse(readFileSync(fileURLToPath(new URL("../personal-build.json", import.meta.url)), "utf8"));
globalThis[Symbol.for("omb.personalRuntimeVersion")] = metadata.version;
app.setAboutPanelOptions({ applicationVersion: metadata.version });
const data = join(app.getPath("home"), ".openmausbot-personal");
mkdirSync(data, { recursive: true, mode: 0o700 });
if (realpathSync(data) !== resolve(data)) throw new Error("Personal data directory must not be a symbolic link");
chmodSync(data, 0o700);
const userData = join(app.getPath("appData"), "OpenMausBot Personal");
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);
app.setAppLogsPath(join(userData, "logs"));
const config = join(data, "config.json");
if (!existsSync(config)) writeFileSync(config, JSON.stringify({
  instances: { codex: { driver: "codex", displayName: "Codex · ChatGPTログイン", config: { cli: "/opt/homebrew/bin/codex" } } },
  newBotDefaults: { profile: { approvalMode: "ask" } }, decider: { enabled: false },
}), { mode: 0o600, flag: "wx" });
const modelRoot = join(metadata.repository, ".privacy-dev");
Object.assign(process.env, {
  ...preparePersonalCodexHome({ directory: join(data, "private", "codex"), loginHome: metadata.codexHome }),
  CUA_DRIVER_HOST_BUNDLE_ID: "dev.sora.openmausbot.personal",
  OMB_DATA_DIR: data, OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_MODE: "off", OMB_PRIVACY_DEVICE: "mps",
  OMB_PRIVACY_PYTHON: join(modelRoot, "venv", "bin", "python"),
  OMB_PRIVACY_WORKER: join(metadata.repository, "scripts", "privacy-worker.py"),
  OMB_PRIVACY_CHECKPOINT: join(modelRoot, "checkpoint", "original"),
  TIKTOKEN_CACHE_DIR: join(modelRoot, "tiktoken"),
});
await import("./main.mjs");

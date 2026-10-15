import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = join(repo, ".privacy-dev");
const source = join(repo, ".local-privacy-filter");
const commit = "f7f00ca7fb869683eb732c010299d901457f19c3";
mkdirSync(root, { recursive: true, mode: 0o700 });
const run = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, UV_CACHE_DIR: join(root, "uv-cache"), ...extraEnv }, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Privacy setup failed: ${command}`);
};
if (!existsSync(source)) {
  run("git", ["clone", "--no-checkout", "https://github.com/openai/privacy-filter.git", source]);
  run("git", ["-C", source, "checkout", "--detach", commit]);
}
const checked = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
if (checked.status !== 0 || checked.stdout.trim() !== commit) throw new Error("Existing local OPF checkout differs from the pinned version; it was left untouched");
const python = join(root, "venv/bin/python");
if (!existsSync(python)) run("uv", ["venv", join(root, "venv"), "--python", "3.12"]);
run("uv", ["pip", "install", "--python", python, "-r", "scripts/privacy-requirements.txt"]);
run(python, ["-c", `
from huggingface_hub import snapshot_download
import tiktoken
snapshot_download('openai/privacy-filter', revision='7ffa9a043d54d1be65afb281eddf0ffbe629385b', local_dir=${JSON.stringify(join(root, "checkpoint"))}, allow_patterns=['original/*'])
tiktoken.get_encoding('o200k_base')
print('Local privacy model and tokenizer are ready. No user text was used.')
`], { HF_HOME: join(root, "hf"), TIKTOKEN_CACHE_DIR: join(root, "tiktoken"), HF_HUB_DISABLE_TELEMETRY: "1" });

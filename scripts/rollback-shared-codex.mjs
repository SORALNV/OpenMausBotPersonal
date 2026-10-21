import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, copyFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CodexSharedClient } from "../server/codex-shared-client.ts";

const user = homedir(), dir = join(user, ".codex/omb-shared"), file = join(dir, "activation.json");
const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid()) throw Error("安全な切替記録を確認できません。");
const receipt = JSON.parse(readFileSync(file, "utf8")), personal = "/Applications/OpenMausBot Personal.app", desktop = "/Applications/ChatGPT.app";
const run = (command, args) => execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
const mains = app => {
  const candidates = run("/bin/ps", ["-axo", "pid=,ppid=,comm="]).split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return m && m[3].startsWith(app + "/Contents/MacOS/") ? [{ pid: +m[1], ppid: +m[2] }] : [];
  });
  const ids = new Set(candidates.map(p => p.pid));
  return candidates.filter(p => !ids.has(p.ppid)).map(p => p.pid);
};
if (mains(desktop).length) throw Error("ChatGPTを⌘Qで終了してから実行してください。会話は削除しません。");
if (receipt.state === "rolled-back") throw Error("既に元に戻しています。");
let activeCliEnv = ""; try { activeCliEnv = run("/bin/launchctl", ["getenv", "CODEX_CLI_PATH"]).trim(); } catch {}
if (receipt.mode === "desktop-owned" && activeCliEnv && activeCliEnv !== receipt.wrapper) throw Error("別のCLI起動設定があるため上書きせず停止しました。");
if (!receipt.previousApp || !existsSync(receipt.previousApp)) throw Error("元のアプリのバックアップを確認できません。");
const digest = createHash("sha256").update(readFileSync(join(personal, "Contents/Resources/server/index.js"))).digest("hex");
if (digest !== receipt.candidateServerHash) throw Error("Personalアプリが切替後に更新されています。別の更新を上書きしないため停止しました。");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", receipt.previousApp]);
let native;
if (receipt.mode !== "desktop-owned" || existsSync(join(dir, "control.sock"))) try {
  native = new CodexSharedClient(join(dir, "control.sock")); await native.initialize();
  let cursor;
  do { const page = await native.request("thread/loaded/list", { ...(cursor ? { cursor } : {}), limit: 100 }); for (const id of page.data ?? []) if ((await native.request("thread/read", { threadId: id })).thread.status?.type === "active") throw Error("共有サーバーで実行中の会話があります。先に完了または停止してください。"); cursor = page.nextCursor; } while (cursor);
} finally { await native?.close(); }
const pids = mains(personal);
if (pids.length > 1) throw Error("複数のPersonalアプリがあります。");
if (pids.length) {
  const response = await fetch("http://127.0.0.1:8897/api/bots?messages=0", { signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).bots.some(b => b.busy || b.tasks?.some(t => t.busy))) throw Error("Personalアプリで実行中の作業があるか、待機状態を確認できません。");
  process.kill(pids[0], "SIGTERM"); const deadline = Date.now() + 20000; while (mains(personal).length) { if (Date.now() > deadline) throw Error("Personalアプリが終了しませんでした。"); await new Promise(r => setTimeout(r, 100)); }
}
const configFile = join(user, ".openmausbot-personal/private/direct-codex.json"), current = JSON.parse(readFileSync(configFile, "utf8")), previous = JSON.parse(readFileSync(join(receipt.backup, "direct-codex.json"), "utf8"));
current.bindings = current.bindings.filter(b => b.threadId !== receipt.sourceThreadId).concat(previous.bindings.filter(b => b.threadId === receipt.sourceThreadId));
const temp = `${configFile}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(current), { mode: 0o600, flag: "wx" }); renameSync(temp, configFile);
if (existsSync(receipt.plistFile)) run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/dev.sora.openmausbot.codex-shared`]);
let env = ""; try { env = run("/bin/launchctl", ["getenv", "CODEX_APP_SERVER_WS_URL"]).trim(); } catch {}
if (env === receipt.endpoint) { if (receipt.previousEnv) run("/bin/launchctl", ["setenv", "CODEX_APP_SERVER_WS_URL", receipt.previousEnv]); else run("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_WS_URL"]); }
rmSync(receipt.plistFile, { force: true });
let cliEnv = ""; try { cliEnv = run("/bin/launchctl", ["getenv", "CODEX_CLI_PATH"]).trim(); } catch {}
if (receipt.wrapper && cliEnv === receipt.wrapper) run("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
if (receipt.environmentPlistFile && existsSync(receipt.environmentPlistFile)) {
  const expected = join(user, "Library/LaunchAgents/dev.sora.openmausbot.codex-desktop-environment.plist");
  if (receipt.environmentPlistFile !== expected) throw Error("予期しないログイン項目のため削除しません。");
  try { run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/dev.sora.openmausbot.codex-desktop-environment`]); } catch {}
  rmSync(expected);
}
if (existsSync(join(receipt.backup, "openmausbot-shared.json"))) copyFileSync(join(receipt.backup, "openmausbot-shared.json"), receipt.endpointFile); else rmSync(receipt.endpointFile, { force: true });
const displaced = join(receipt.backup, "replaced-update"); mkdirSync(displaced, { mode: 0o700 }); renameSync(personal, join(displaced, "OpenMausBot Personal.app")); renameSync(receipt.previousApp, personal);
receipt.state = "rolled-back"; receipt.rolledBackAt = new Date().toISOString(); writeFileSync(file, JSON.stringify(receipt, null, 2), { mode: 0o600 });
run("/usr/bin/open", ["--env", "CODEX_APP_SERVER_FORCE_CLI=1", "-a", desktop]); run("/usr/bin/open", ["-a", personal]);
console.log("通常の接続と元のPersonalアプリへ戻しました。会話・プライバシー設定・認証情報は削除していません。");

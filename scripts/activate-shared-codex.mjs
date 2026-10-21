import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { CodexSharedClient } from "../server/codex-shared-client.ts";
import { nativeHistory } from "../server/direct-codex-client.ts";

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } }, strict: true });
const repo = dirname(dirname(fileURLToPath(import.meta.url))), user = homedir(), nativeHome = join(user, ".codex"), dir = join(nativeHome, "omb-shared");
const personal = "/Applications/OpenMausBot Personal.app", desktop = "/Applications/ChatGPT.app";
const data = join(user, ".openmausbot-personal"), nativeThread = "019e6f25-8809-7713-b919-70b49f4c806d", botId = "33533fa5-2706-47a4-9331-9746ff2cd4c5", sourceThread = "216e1c8f-c716-4391-b12f-87e13f582ab8";
const configFile = join(data, "private/direct-codex.json"), endpointFile = join(nativeHome, "openmausbot-shared.json"), label = "dev.sora.openmausbot.codex-shared";
const plistFile = join(user, "Library/LaunchAgents", label + ".plist"), socket = join(dir, "control.sock"), endpoint = `ws+unix://localhost${socket}:/rpc`;
const run = (file, args) => execFileSync(file, args, { stdio: "pipe", encoding: "utf8" });
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const atomic = (file, value) => { const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" }); renameSync(temp, file); };
const privateExisting = file => { if (!existsSync(file)) return; const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077) throw Error("予期しない設定ファイルのため停止しました: " + file); };
const processes = () => run("/bin/ps", ["-axo", "pid=,ppid=,comm="]).split("\n").flatMap(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return m ? [{ pid: +m[1], ppid: +m[2], command: m[3] }] : []; });
const mains = app => {
  const candidates = processes().filter(p => p.command.startsWith(app + "/Contents/MacOS/"));
  const ids = new Set(candidates.map(p => p.pid));
  return candidates.filter(p => !ids.has(p.ppid));
};
const buildFile = join(repo, ".privacy-dev/direct-codex-bridge/build.json"), build = JSON.parse(readFileSync(buildFile, "utf8"));
const sharedProof = JSON.parse(readFileSync(join(repo, ".privacy-dev/direct-codex-bridge/shared-acceptance.json"), "utf8"));
const desktopProof = JSON.parse(readFileSync(join(repo, ".privacy-dev/direct-codex-bridge/desktop-startup-probe.json"), "utf8"));
if (!desktopProof.ok || desktopProof.desktopAsarHash !== hash(join(desktop, "Contents/Resources/app.asar"))) throw Error("ChatGPTアプリが検証時から変化しています。接続試験をやり直す必要があります。");
if (!sharedProof.ok || sharedProof.server !== join(build.app, "Contents/Resources/server/index.js")) throw Error("候補アプリの共有接続試験が未完了です。");
if (hash(sharedProof.server) !== build.serverHash) throw Error("候補アプリが検証後に変更されています。");
if (hash(join(personal, "Contents/Resources/app.asar")) !== hash(join(build.app, "Contents/Resources/app.asar"))) throw Error("インストール済みPersonalアプリが変化しています。候補の再ビルドが必要です。");
for (const [file, digest] of Object.entries(build.sourceHashes)) if (hash(join(repo, file)) !== digest) throw Error("検証後にソースが変わっています: " + file);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", build.app]); run("/usr/bin/codesign", ["--verify", "--deep", "--strict", personal]);
privateExisting(configFile); privateExisting(endpointFile);
const saved = JSON.parse(readFileSync(configFile, "utf8")), oldBinding = saved.bindings.find(b => b.threadId === sourceThread);
if (!oldBinding || oldBinding.botId !== botId || oldBinding.codexThreadId !== nativeThread) throw Error("M1の元の接続先と一致しないため停止しました。");
if (existsSync(endpointFile) && JSON.parse(readFileSync(endpointFile, "utf8")).managedBy !== "openmausbot-personal") throw Error("別の共有設定があるため停止しました。");
let previousEnv = ""; try { previousEnv = run("/bin/launchctl", ["getenv", "CODEX_APP_SERVER_WS_URL"]).trim(); } catch {}
if (previousEnv && previousEnv !== endpoint) throw Error("別のChatGPT接続先が設定されています。上書きはしません。");
const desktopRunning = mains(desktop).length > 0;
if (values.check) { console.log(JSON.stringify({ ready: true, desktopMustQuit: desktopRunning, originalThreadId: nativeThread, sourceThreadId: sourceThread, candidate: build.app, fork: false, changesMade: false })); process.exit(0); }
if (desktopRunning) throw Error("ChatGPTアプリを⌘Qで完全に終了してから、このコマンドを再実行してください。会話の削除は不要です。");
const busyResponse = await fetch("http://127.0.0.1:8897/api/bots?messages=0", { signal: AbortSignal.timeout(5000) });
if (!busyResponse.ok) throw Error("Personalアプリの待機状態を確認できません。先にPersonalアプリの起動・キーチェーン確認を完了してください。");
const bots = (await busyResponse.json()).bots;
if (bots.some(b => b.busy || b.tasks?.some(t => t.busy))) throw Error("Personalアプリで実行中の作業があります。完了後に再実行してください。");
if (!bots.some(b => b.id === botId && b.tasks?.some(t => t.threadId === sourceThread))) throw Error("M1のスレッドが見つかりません。");
const backup = join(repo, ".privacy-dev/local-backups", "shared-codex-" + randomUUID()); mkdirSync(backup, { recursive: true, mode: 0o700 });
copyFileSync(configFile, join(backup, "direct-codex.json"));
if (existsSync(endpointFile)) copyFileSync(endpointFile, join(backup, "openmausbot-shared.json"));
if (existsSync(plistFile)) throw Error("同名の起動サービスが既にあります。再インストールせず、設定を確認してください。");
const sourcePrivacy = join(data, "private/settings.json"), privacyHash = hash(sourcePrivacy);
mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
copyFileSync(join(repo, "scripts/shared-codex-host.mjs"), join(dir, "host.mjs")); chmodSync(join(dir, "host.mjs"), 0o600);
const node = existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
const plist = { Label: label, ProgramArguments: [node, join(dir, "host.mjs"), "--cli", desktop + "/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "--home", nativeHome, "--directory", dir, "--publish-env"], RunAtLoad: true, KeepAlive: true, ProcessType: "Background", ThrottleInterval: 10 };
mkdirSync(dirname(plistFile), { recursive: true }); writeFileSync(plistFile, JSON.stringify(plist), { mode: 0o600, flag: "wx" }); run("/usr/bin/plutil", ["-convert", "xml1", plistFile]);
const receipt = { createdAt: new Date().toISOString(), backup, nativeThreadId: nativeThread, sourceThreadId: sourceThread, endpoint, endpointFile, plistFile, previousEnv, candidateServerHash: build.serverHash, state: "starting", originalThreadForked: false };
const receiptFile = join(dir, "activation.json"); atomic(receiptFile, receipt);
let client, personalStopped = false, appMoved = false;
const stage = `/Applications/.OpenMausBot-shared-${randomUUID()}.app`, previousApp = join(backup, "OpenMausBot Personal.app");
try {
  run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistFile]);
  const deadline = Date.now() + 25000;
  for (;;) { const statusFile = join(dir, "status.json"); if (existsSync(statusFile) && JSON.parse(readFileSync(statusFile, "utf8")).state === "ready") break; if (Date.now() > deadline) throw Error("共有サーバーの起動が完了しませんでした。"); await new Promise(r => setTimeout(r, 100)); }
  client = new CodexSharedClient(socket); await client.initialize(); const original = await client.request("thread/read", { threadId: nativeThread });
  if (original.thread.id !== nativeThread || original.thread.name !== "M1MacControl") throw Error("元のM1MacControlを確認できません。");
  const anchor = (await nativeHistory(client, nativeThread, 1)).at(-1)?.id;
  run("/usr/bin/ditto", [build.app, stage]); run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stage]);
  const running = mains(personal); if (running.length > 1) throw Error("複数のPersonalアプリがあるため停止しました。");
  if (running.length) { process.kill(running[0].pid, "SIGTERM"); const until = Date.now() + 20000; while (mains(personal).length) { if (Date.now() > until) throw Error("Personalアプリが終了しませんでした。"); await new Promise(r => setTimeout(r, 100)); } }
  personalStopped = true;
  renameSync(personal, previousApp); appMoved = true; renameSync(stage, personal); run("/usr/bin/codesign", ["--verify", "--deep", "--strict", personal]);
  atomic(endpointFile, { version: 1, managedBy: "openmausbot-personal", socketPath: socket });
  const selection = { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 60000 };
  Object.assign(oldBinding, { enabled: true, mediator: selection, formatter: oldBinding.formatter ?? selection, ...(anchor ? { lastNativeTurnId: anchor } : {}) }); atomic(configFile, saved);
  receipt.directConfigHash = hash(configFile);
  if (hash(sourcePrivacy) !== privacyHash) throw Error("プライバシー設定が変化したため停止しました。");
  run("/usr/bin/open", ["--env", "CODEX_APP_SERVER_WS_URL=" + endpoint, "--env", "CODEX_HOME=" + nativeHome, "-a", desktop]);
  run("/usr/bin/open", ["codex://threads/" + nativeThread]);
  const desktopDeadline = Date.now() + 60000;
  for (;;) {
    const state = (await client.request("thread/read", { threadId: nativeThread })).thread.status?.type;
    if (state === "idle" || state === "active") break;
    if (Date.now() > desktopDeadline) throw Error("ChatGPTでM1MacControlを開く準備が完了しませんでした。ChatGPTの起動・ログイン画面を確認してください。共有サーバーは停止していません。");
    await new Promise(r => setTimeout(r, 250));
  }
  receipt.desktopLoadedOriginalThread = true;
  run("/usr/bin/open", ["-a", personal]);
  Object.assign(receipt, { state: "launched-awaiting-ui-verification", previousApp, privacySettingsUnchanged: true }); atomic(receiptFile, receipt);
  console.log("共有方式で両アプリを起動しました。元のM1MacControlとPersonalのM1で、入力・回答・承認の最終確認を行ってください。\nバックアップ: " + backup);
} catch (error) {
  if (!mains(desktop).length) {
    if (appMoved) { rmSync(personal, { recursive: true, force: true }); renameSync(previousApp, personal); }
    copyFileSync(join(backup, "direct-codex.json"), configFile);
    if (existsSync(join(backup, "openmausbot-shared.json"))) copyFileSync(join(backup, "openmausbot-shared.json"), endpointFile); else rmSync(endpointFile, { force: true });
    try { run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`]); } catch {}
    rmSync(plistFile, { force: true });
    if (!previousEnv) { try { run("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_WS_URL"]); } catch {} }
    if (personalStopped) run("/usr/bin/open", ["-a", personal]);
    receipt.state = "rolled-back";
  } else receipt.state = "needs-manual-review-before-rollback";
  receipt.error = error instanceof Error ? error.message : "Activation failed"; atomic(receiptFile, receipt); throw error;
} finally { await client?.close(); rmSync(stage, { recursive: true, force: true }); }

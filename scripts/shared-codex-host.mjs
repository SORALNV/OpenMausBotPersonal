import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, lstatSync, realpathSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const { values } = parseArgs({ options: { cli: { type: "string" }, home: { type: "string" }, directory: { type: "string" }, "publish-env": { type: "boolean", default: false } }, strict: true });
if (![values.cli, values.home, values.directory].every(p => p && isAbsolute(p))) throw Error("Explicit CLI, native home and private service directory are required");
mkdirSync(values.directory, { recursive: true, mode: 0o700 });
const dir = realpathSync(values.directory), info = lstatSync(dir), owner = process.getuid();
if (!info.isDirectory() || info.uid !== owner || info.mode & 0o077) throw Error("Shared service directory must be owner-private");
const socket = join(dir, "control.sock"), endpoint = `ws+unix://localhost${socket}:/rpc`, file = join(dir, "status.json");
if (/[:\r\n]/.test(socket)) throw Error("Unsupported socket path");
const status = { version: 1, managedBy: "openmausbot-personal", startedAt: new Date().toISOString(), hostPid: process.pid, socketPath: socket, endpoint, state: "starting" };
const save = () => { const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(status), { mode: 0o600, flag: "wx" }); renameSync(temp, file); };
save();
const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
const child = spawn(values.cli, ["app-server", "--listen", `unix://${socket}`], { env: { ...env, CODEX_HOME: values.home, CODEX_SQLITE_HOME: values.home }, stdio: ["ignore", "pipe", "pipe"] });
status.nativePid = child.pid; save(); child.stdout.resume(); child.stderr.resume();
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; status.state = "stopping"; save();
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref(); }
}
process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
child.on("error", () => { status.state = "failed"; status.reason = "native-start-failed"; save(); process.exitCode = 1; });
child.on("exit", (code, signal) => { status.state = stopping ? "stopped" : "failed"; status.exitCode = code; status.signal = signal; save(); if (!stopping) process.exitCode = 1; });
try {
  const deadline = Date.now() + 20000;
  while (!stopping) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error("Native server exited during startup");
    if (existsSync(socket)) {
      const entry = lstatSync(socket), target = realpathSync(socket), targetInfo = lstatSync(target);
      if (entry.uid === owner && targetInfo.isSocket() && targetInfo.uid === owner && !(targetInfo.mode & 0o077)) break;
    }
    if (Date.now() > deadline) throw Error("Native socket startup timed out");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!stopping) {
    if (values["publish-env"]) execFileSync("/bin/launchctl", ["setenv", "CODEX_APP_SERVER_WS_URL", endpoint], { stdio: "pipe" });
    status.state = "ready"; save();
  }
} catch { status.state = "failed"; status.reason = "shared-startup-failed"; save(); process.exitCode = 1; await stop(); }

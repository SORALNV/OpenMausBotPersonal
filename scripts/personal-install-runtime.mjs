import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runtimeRequirement, verifyPersonalRuntime } from "../electron/personal-runtime-verifier.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, ".privacy-dev/evidence/personal-runtime-package.json"), "utf8"));
runtimeRequirement(pkg.fingerprint);
const launcherRequirement = `=identifier "dev.sora.openmausbot.personal" and certificate leaf = H"${pkg.fingerprint}"`;
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`Runtime install failed: ${command}`);
  return result.stdout;
};
const destination = "/Applications/OpenMausBot Personal.app";
// Never replace a running app or change its runtime underneath an active turn.
const processes = run("/bin/ps", ["-axo", "command="]);
if (processes.split("\n").some(line => line.startsWith(`${destination}/Contents/MacOS/`))) throw new Error("Quit Personal before installing its runtime");
const data = join(homedir(), ".openmausbot-personal"), root = join(data, "runtime");
if (realpathSync(data) !== resolve(data) || lstatSync(data).uid !== process.getuid()) throw new Error("Invalid Personal data directory");
mkdirSync(root, { recursive: true, mode: 0o700 });
const versions = join(root, "versions");
mkdirSync(versions, { mode: 0o700, recursive: true });
for (const path of [root, versions]) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path) || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Invalid runtime directory");
}
const id = randomUUID(), version = join(versions, id);
mkdirSync(version, { mode: 0o700 });
run("/usr/bin/ditto", [pkg.runtime, join(version, "OpenMausBot Runtime.app")]);
// Verify the staged version before atomically changing the active pointer.
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--test-requirement", runtimeRequirement(pkg.fingerprint), join(version, "OpenMausBot Runtime.app")]);
const backup = join(repo, ".privacy-dev/local-backups", `runtime-${id}`);
mkdirSync(backup, { recursive: true, mode: 0o700 });
const active = join(root, "active.json");
if (existsSync(active)) writeFileSync(join(backup, "active.json"), readFileSync(active), { mode: 0o600, flag: "wx" });
const pnpm = join(repo, "node_modules/.pnpm");
const { readdirSync } = await import("node:fs");
const asar = createRequire(import.meta.url)(join(pnpm, readdirSync(pnpm).find(name => name.startsWith("@electron+asar@")), "node_modules/@electron/asar/lib/asar.js"));
let current;
try { current = JSON.parse(asar.extractFile(join(destination, "Contents/Resources/app.asar"), "personal-launcher.json").toString()); } catch { current = null; }
const migrate = !current || process.argv.includes("--migrate-launcher");
if (current && (current.version !== 1 || current.fingerprint !== pkg.fingerprint)) throw new Error("Existing launcher identity differs; explicit migration required");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--test-requirement", launcherRequirement, destination]);
if (migrate) {
  run("/usr/bin/ditto", [destination, join(backup, "OpenMausBot Personal.app")]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--test-requirement", launcherRequirement, pkg.launcher]);
}
const temporary = join(root, `active-${id}.json`);
writeFileSync(temporary, JSON.stringify({ version: 1, id }), { mode: 0o600, flag: "wx" });
renameSync(temporary, active);
try { await verifyPersonalRuntime({ root, fingerprint: pkg.fingerprint }); }
catch (error) {
  if (existsSync(join(backup, "active.json"))) writeFileSync(active, readFileSync(join(backup, "active.json")), { mode: 0o600 });
  throw error;
}
if (migrate) {
  // Rename the verified replacement in the same directory; keep the old app in the backup.
  const candidate = `/Applications/.OpenMausBot-Personal-${id}.app`;
  run("/usr/bin/ditto", [pkg.launcher, candidate]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate]);
  const old = `/Applications/.OpenMausBot-Personal-previous-${id}.app`;
  renameSync(destination, old);
  try { renameSync(candidate, destination); } catch (error) { renameSync(old, destination); throw error; }
  const { rmSync } = await import("node:fs");
  rmSync(old, { recursive: true });
}
chmodSync(active, 0o600);
const result = { id, backup, migrate, destination, installedAt: new Date().toISOString() };
writeFileSync(join(repo, ".privacy-dev/evidence/personal-runtime-install.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));

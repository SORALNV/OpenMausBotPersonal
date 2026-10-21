import { parse as parseYaml } from "yaml";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { withPersonalSigning, personalSigningRequirement } from "./personal-signing.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const revision = (ref) => {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot identify source revision: ${ref}`);
  return result.stdout.trim();
};
const sourceCommit = revision("HEAD");
const upstreamCommit = revision("upstream/main");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This local build requires an Apple silicon Mac");
const base = process.env.OMB_PERSONAL_BASE_APP ?? "/Users/sora/.Trash/OpenMausBot.app";
const build = join(repo, ".privacy-dev", "personal-build", randomUUID());
const app = join(build, "OpenMausBot Personal.app");
const run = (cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd: repo, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Personal application build failed: ${cmd}`);
};
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", base]);
run(join(repo, "node_modules/.bin/tsc"), ["-b"]);
run(join(repo, "node_modules/.bin/tsc"), ["-p", "tsconfig.server.build.json"]);
run(process.execPath, ["scripts/bundle-server.mjs"]);
run(join(repo, "node_modules/.bin/tsc"), ["-p", "tsconfig.companion.build.json"]);
run(process.execPath, ["scripts/mark-module-scope.mjs", "dist-companion"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build"], { ...process.env, VITE_OMB_PRIVACY_STRICT: "0", VITE_OMB_PERSONAL: "1" });
run(process.execPath, ["electron/build-speech-helper.mjs"]);
mkdirSync(build, { recursive: true, mode: 0o700 });
run("/usr/bin/ditto", [base, app]);
const resources = join(app, "Contents", "Resources");
for (const [source, target] of [["dist", "ui"], ["dist-server", "server"], ["dist-companion", "companion"], ["skills", "skills"]]) {
  const dest = join(resources, target);
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(repo, source), dest, { recursive: true });
}
const resourcesManifest = parseYaml(readFileSync(join(repo, "electron-builder.yml"), "utf8"));
for (const entry of resourcesManifest.extraResources.filter(entry => entry.to.startsWith("licenses/"))) {
  const target = join(resources, entry.to);
  mkdirSync(join(resources, "licenses"), { recursive: true });
  cpSync(join(repo, entry.from), target);
}
const speechBundle = "OpenMausBot Speech.app";
rmSync(join(resources, speechBundle), { recursive: true, force: true });
cpSync(join(repo, "electron/resources", speechBundle), join(resources, speechBundle), { recursive: true });
const source = join(build, "source");
mkdirSync(source);
cpSync(join(repo, "electron"), join(source, "electron"), { recursive: true, filter: p => !/\.(?:test|node-test)\./.test(p) && !p.includes("/fixtures/") });
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
writeFileSync(join(source, "package.json"), JSON.stringify({ name: "openmausbot-personal", productName: "OpenMausBot Personal", version: pkg.version, main: "electron/personal-main.mjs", type: "module" }));
writeFileSync(join(source, "personal-build.json"), JSON.stringify({ repository: repo, version: pkg.version, sourceCommit, upstreamCommit, codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex") }));
const pnpm = join(repo, "node_modules", ".pnpm");
const asarPackage = readdirSync(pnpm).find(name => name.startsWith("@electron+asar@"));
if (!asarPackage) throw new Error("The installed ASAR build dependency is missing");
const asar = createRequire(import.meta.url)(join(pnpm, asarPackage, "node_modules/@electron/asar/lib/asar.js"));
const archive = join(resources, "app.asar");
rmSync(archive);
await asar.createPackage(source, archive);
const info = join(app, "Contents", "Info.plist");
const edit = (key, value) => run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, info]);
edit("CFBundleIdentifier", "dev.sora.openmausbot.personal");
edit("CFBundleShortVersionString", pkg.version);
edit("CFBundleVersion", pkg.version);
// Electron locates its native helper by CFBundleName. Keep the name used by
// the reused, signed runtime; CFBundleDisplayName supplies our visible name.
edit("CFBundleName", "OpenMausBot");
if (spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleDisplayName", info], { stdio: "ignore" }).status === 0) edit("CFBundleDisplayName", "OpenMausBot Personal");
else run("/usr/libexec/PlistBuddy", ["-c", "Add :CFBundleDisplayName string OpenMausBot Personal", info]);
const raw = asar.getRawHeader(archive);
const integrity = { "Resources/app.asar": { algorithm: "SHA256", hash: createHash("sha256").update(raw.headerString).digest("hex") } };
run("/usr/bin/plutil", ["-replace", "ElectronAsarIntegrity", "-json", JSON.stringify(integrity), info]);
rmSync(join(resources, "app-update.yml"), { force: true });
const signing = withPersonalSigning(join(repo, ".privacy-dev", "personal-signing"), ({ identity, keychain }) => {
  run("/usr/bin/codesign", ["--force", "--sign", identity, "--keychain", keychain, "--timestamp=none", "--options", "runtime", "--entitlements", join(repo, "build/entitlements.mac.plist"), join(resources, speechBundle)]);
  const speechHelperRequirement = personalSigningRequirement(join(resources, speechBundle), identity);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, "--keychain", keychain, "--timestamp=none", "--options", "runtime", "--entitlements", join(repo, "build/entitlements.mac.plist"), app]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  return { kind: "local-certificate", certificateSha1: identity, designatedRequirement: personalSigningRequirement(app, identity), speechHelperRequirement };
});
const evidence = join(repo, ".privacy-dev", "evidence", "personal-app-build.json");
writeFileSync(evidence, JSON.stringify({ app, base, version: pkg.version, sourceCommit, upstreamCommit, signing, builtAt: new Date().toISOString(), installed: false }, null, 2), { mode: 0o600 });
console.log(app);
if (process.argv.includes("--install")) {
  const dest = "/Applications/OpenMausBot Personal.app";
  if (existsSync(dest)) throw new Error("The personal application already exists; it was left untouched");
  run("/usr/bin/ditto", [app, dest]);
  console.log(dest);
}

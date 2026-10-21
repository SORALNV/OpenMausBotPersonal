import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { withPersonalSigning } from "./personal-signing.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const build = JSON.parse(readFileSync(join(repo, ".privacy-dev/evidence/personal-app-build.json"), "utf8"));
const directory = join(repo, ".privacy-dev/personal-runtime", randomUUID());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Runtime packaging failed: ${command}`);
};
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", build.app]);
const runtime = join(directory, "OpenMausBot Runtime.app");
run("/usr/bin/ditto", [build.app, runtime]);
writeFileSync(join(runtime, "Contents/Resources/personal-runtime-release.json"), JSON.stringify({ version: 1, id: directory.split("/").at(-1), packagedAt: new Date().toISOString() }));
run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier dev.sora.openmausbot.personal.runtime", join(runtime, "Contents/Info.plist")]);
const launcher = join(directory, "OpenMausBot Personal.app");
run("/usr/bin/ditto", [build.app, launcher]);
const source = join(directory, "launcher-source");
mkdirSync(join(source, "electron"), { recursive: true, mode: 0o700 });
for (const name of ["personal-launcher.mjs", "personal-runtime-verifier.mjs"]) cpSync(join(repo, "electron", name), join(source, "electron", name));
writeFileSync(join(source, "package.json"), JSON.stringify({ name: "openmausbot-personal", productName: "OpenMausBot Personal", version: build.version, main: "electron/personal-launcher.mjs", type: "module" }));
writeFileSync(join(source, "personal-launcher.json"), JSON.stringify({ version: 1, fingerprint: build.signing.certificateSha1 }));
const pnpm = join(repo, "node_modules/.pnpm");
const asarPackage = readdirSync(pnpm).find(name => name.startsWith("@electron+asar@"));
const asar = createRequire(import.meta.url)(join(pnpm, asarPackage, "node_modules/@electron/asar/lib/asar.js"));
const archive = join(launcher, "Contents/Resources/app.asar");
rmSync(archive);
await asar.createPackage(source, archive);
const integrity = { "Resources/app.asar": { algorithm: "SHA256", hash: createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex") } };
run("/usr/bin/plutil", ["-replace", "ElectronAsarIntegrity", "-json", JSON.stringify(integrity), join(launcher, "Contents/Info.plist")]);
withPersonalSigning(join(repo, ".privacy-dev/personal-signing"), ({ identity, keychain }) => {
  for (const app of [runtime, launcher]) {
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, "--keychain", keychain, "--timestamp=none", "--options", "runtime", "--entitlements", join(repo, "build/entitlements.mac.plist"), app]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  }
});
writeFileSync(join(repo, ".privacy-dev/evidence/personal-runtime-package.json"), JSON.stringify({ directory, runtime, launcher, sourceBuild: build.app, fingerprint: build.signing.certificateSha1, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ directory, runtime, launcher }));

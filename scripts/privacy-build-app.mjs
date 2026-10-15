import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

if (process.platform !== "darwin") throw new Error("This application requires macOS");
const repo = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const build = join(repo, ".privacy-dev", "app-build", randomUUID());
const app = join(build, "OpenMausBot Privacy.app");
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]
  .find(path => existsSync(path) && realpathSync(path) === realpathSync(process.execPath));
if (!node) throw new Error("Node.js path is unavailable");
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OpenMausBotPrivacy</string>
<key>CFBundleIdentifier</key><string>dev.sora.openmausbot.privacy</string>
<key>CFBundleName</key><string>OpenMausBot Privacy</string>
<key>CFBundleDisplayName</key><string>OpenMausBot Privacy</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>PrivacyRepositoryPath</key><string>${xml(repo)}</string>
<key>PrivacyNodePath</key><string>${xml(node)}</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`);
copyFileSync(join(repo, "build", "icon.icns"), join(app, "Contents", "Resources", "AppIcon.icns"));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Application build failed: ${command}`);
};
run("/usr/bin/xcrun", ["swiftc", "-O", "-parse-as-library", "-swift-version", "5", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
  "-module-cache-path", join(repo, ".privacy-dev", "swift-cache"), "-framework", "AppKit", "-framework", "WebKit",
  "macos/PrivacyApp.swift", "-o", join(app, "Contents", "MacOS", "OpenMausBotPrivacy")]);
run("/usr/bin/codesign", ["--force", "--sign", "-", app]);
const installed = "/Applications/OpenMausBot Privacy.app";
if (process.argv.includes("--install")) {
  if (lstatSync(installed, { throwIfNoEntry: false })) throw new Error("The destination app already exists; it was left untouched");
  run("/usr/bin/ditto", [app, installed]);
}
console.log(process.argv.includes("--install") ? installed : app);
mkdirSync(join(repo, ".privacy-dev", "evidence"), { recursive: true, mode: 0o700 });
writeFileSync(join(repo, ".privacy-dev", "evidence", "native-app-build.json"), JSON.stringify({ app, installed: process.argv.includes("--install") ? installed : null }, null, 2) + "\n", { mode: 0o600 });

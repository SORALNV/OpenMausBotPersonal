// Stage the Windows private-file addon the way prepare-duckdb stages the Data engine:
// dist-native/win-private/win32-x64/node_modules/@openmausbot/win-private, which
// electron-builder copies outside ASAR and the server resolves through the
// OMB_RESOURCES_PATH anchor (server/private-file.ts). The tree is created on every
// platform so the win extraResources source always exists; the binding itself only
// builds on Windows x64, and without it the server fails closed through the POSIX
// predicate.
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "packages", "win-private");
const destination = join(root, "dist-native", "win-private", "win32-x64");
const staged = join(destination, "node_modules", "@openmausbot", "win-private");

rmSync(destination, { recursive: true, force: true });
cpSync(join(source, "package.json"), join(staged, "package.json"));
// A resolvable anchor whose upward createRequire search lands in the staged node_modules.
writeFileSync(join(destination, "node_modules", "openmausbot-win-private-anchor.js"), "");

const build = join(source, "build");
if (existsSync(build)) {
  cpSync(build, join(staged, "build"), { recursive: true });
  console.log(`win-private: staged ${readdirSync(join(staged, "build")).join(", ")}`);
} else {
  console.log("win-private: no built binding for this platform; staged manifest only");
}

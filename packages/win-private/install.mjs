// Builds the addon where Windows x64 has a toolchain; a machine that cannot
// build must not break the install, because the server falls back to the POSIX
// predicate, which refuses every Windows file's owner-private claim.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32" && process.arch === "x64") {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const gyp = fileURLToPath(new URL("./node_modules/node-gyp/bin/node-gyp.js", import.meta.url));
  try {
    execFileSync(process.execPath, [gyp, "rebuild"], { stdio: "inherit", cwd: here });
  } catch (error) {
    console.warn(`[win-private] the addon did not build; private files stay fail-closed on Windows\n${error}`);
  }
}

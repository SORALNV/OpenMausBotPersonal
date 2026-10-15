import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const CONFIG = 'cli_auth_credentials_store = "file"\n[features]\ndaemon_auto_start = false\nmemories = false\n';
const inspect = path => {
  try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

/** Keep native threads out of the user's Codex home; only its file-based sign-in is shared.
 * Codex 0.160's file credential writer follows this link. Never replace a detached credential file. */
export function preparePersonalCodexHome({ directory, loginHome }) {
  if (!isAbsolute(directory) || !isAbsolute(loginHome)) throw new Error("Codex directories must be absolute");
  const source = realpathSync(loginHome);
  const target = resolve(directory);
  if (target === source || target.startsWith(source + sep)) throw new Error("Personal Codex history must have its own directory");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = lstatSync(target);
  if (!stat.isDirectory() || realpathSync(target) !== target || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Personal Codex directory must be an owned directory without symbolic links");
  }
  chmodSync(target, 0o700);
  const config = join(target, "config.toml");
  const existing = inspect(config);
  if (existing) {
    if (!existing.isFile() || existing.nlink !== 1 || readFileSync(config, "utf8") !== CONFIG) {
      throw new Error("Personal Codex configuration differs from its isolated configuration");
    }
  } else writeFileSync(config, CONFIG, { mode: 0o600, flag: "wx" });
  chmodSync(config, 0o600);
  const auth = join(source, "auth.json");
  const credentials = inspect(auth);
  if (credentials && (!credentials.isFile() || credentials.nlink !== 1 || (credentials.mode & 0o077) ||
    (process.getuid && credentials.uid !== process.getuid()))) {
    throw new Error("The shared Codex sign-in must be an owned private regular file");
  }
  const link = join(target, "auth.json");
  const linked = inspect(link);
  if (!linked) symlinkSync(auth, link);
  else if (!linked.isSymbolicLink() || resolve(dirname(link), readlinkSync(link)) !== auth) {
    throw new Error("Personal Codex sign-in is detached from the shared login; no credentials were replaced");
  }
  return { CODEX_HOME: target, CODEX_SQLITE_HOME: target };
}

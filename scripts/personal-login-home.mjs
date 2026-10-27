import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export function personalLoginHome({ home, env = process.env }) {
  const candidate = env.OMB_PERSONAL_CODEX_LOGIN_HOME ?? join(home, ".codex");
  if (typeof candidate !== "string" || !isAbsolute(candidate)) throw new Error("Personal shared Codex login home must be absolute");
  const canonical = path => existsSync(path) ? realpathSync(path) : resolve(path);
  const source = canonical(candidate), state = canonical(join(home, ".openmausbot-personal", "private", "codex"));
  if (source === state || source.startsWith(state + sep) || state.startsWith(source + sep)) {
    throw new Error("Personal shared Codex login home overlaps its private history directory; use the original login home");
  }
  return source;
}

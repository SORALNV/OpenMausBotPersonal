import assert from "node:assert/strict";
import { test } from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePersonalCodexHome } from "./personal-codex-home.mjs";

function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-codex-home-")));
  const loginHome = join(root, "shared"), directory = join(root, "private");
  mkdirSync(loginHome, { mode: 0o700 });
  writeFileSync(join(loginHome, "auth.json"), "synthetic-before", { mode: 0o600 });
  try { run({ root, loginHome, directory }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("separates native state and follows a replaced login without copying credentials or config", () => fixture(options => {
  const { loginHome, directory } = options;
  writeFileSync(join(loginHome, "config.toml"), "sqlite_home = \"/synthetic/shared\"\n");
  const env = preparePersonalCodexHome(options);
  assert.deepEqual(env, { CODEX_HOME: directory, CODEX_SQLITE_HOME: directory });
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(directory, "config.toml")).mode & 0o777, 0o600);
  assert(lstatSync(join(directory, "auth.json")).isSymbolicLink());
  assert(!readFileSync(join(directory, "config.toml"), "utf8").includes("/synthetic/shared"));
  writeFileSync(join(loginHome, "rotated"), "synthetic-after", { mode: 0o600 });
  renameSync(join(loginHome, "rotated"), join(loginHome, "auth.json"));
  assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "synthetic-after");
  assert.deepEqual(preparePersonalCodexHome(options), env);
}));

test("refuses a detached credential file without overwriting either login", () => fixture(options => {
  preparePersonalCodexHome(options);
  const auth = join(options.directory, "auth.json");
  rmSync(auth); writeFileSync(auth, "detached", { mode: 0o600 });
  assert.throws(() => preparePersonalCodexHome(options), /detached/);
  assert.equal(readFileSync(auth, "utf8"), "detached");
  assert.equal(readFileSync(join(options.loginHome, "auth.json"), "utf8"), "synthetic-before");
}));

test("refuses redirects back into shared history or another credential store", () => fixture(options => {
  assert.throws(() => preparePersonalCodexHome({ ...options, directory: join(options.loginHome, "private") }), /own directory/);
  mkdirSync(options.directory);
  symlinkSync(join(options.root, "other-auth"), join(options.directory, "auth.json"));
  assert.throws(() => preparePersonalCodexHome(options), /detached/);
}));

test("refuses a linked state directory or modified state configuration", () => fixture(options => {
  const actual = join(options.root, "actual"); mkdirSync(actual);
  symlinkSync(actual, options.directory);
  assert.throws(() => preparePersonalCodexHome(options), /without symbolic links/);
  rmSync(options.directory);
  preparePersonalCodexHome(options);
  writeFileSync(join(options.directory, "config.toml"), 'sqlite_home="/shared"');
  assert.throws(() => preparePersonalCodexHome(options), /configuration differs/);
}));

test("leaves source sign-out intact and follows a later source sign-in", () => fixture(options => {
  const auth = join(options.loginHome, "auth.json"); rmSync(auth);
  preparePersonalCodexHome(options);
  assert.throws(() => readFileSync(join(options.directory, "auth.json")), /ENOENT/);
  writeFileSync(auth, "new-sign-in", { mode: 0o600 });
  preparePersonalCodexHome(options);
  assert.equal(readFileSync(join(options.directory, "auth.json"), "utf8"), "new-sign-in");
}));

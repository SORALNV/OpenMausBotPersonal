import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalLoginHome } from "./personal-login-home.mjs";

test("a build delegated to a Personal bot uses the shared sign-in instead of inherited private history", () => {
  const home = join(tmpdir(), "synthetic-login-home");
  for (const CODEX_HOME of [join(home, ".openmausbot-personal/private/codex"), join(home, "unrelated")]) {
    assert.equal(personalLoginHome({ home, env: { CODEX_HOME } }), join(home, ".codex"));
  }
});

test("explicit shared login homes are allowed while relative and overlapping histories are rejected", () => {
  const home = join(tmpdir(), "synthetic-login-home"), state = join(home, ".openmausbot-personal/private/codex");
  const choose = value => personalLoginHome({ home, env: { OMB_PERSONAL_CODEX_LOGIN_HOME: value } });
  assert.equal(choose(join(home, "shared-account")), join(home, "shared-account"));
  for (const value of ["relative", state, join(state, "nested"), join(home, ".openmausbot-personal/private")]) assert.throws(() => choose(value), /absolute|overlaps/);
});

test("a symlink alias cannot hide an overlapping private history", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "omb-build-login-"));
  try {
    const state = join(home, ".openmausbot-personal/private/codex"), alias = join(home, "alias");
    mkdirSync(state, { recursive: true }); symlinkSync(state, alias);
    assert.throws(() => personalLoginHome({ home, env: { OMB_PERSONAL_CODEX_LOGIN_HOME: alias } }), /overlaps/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

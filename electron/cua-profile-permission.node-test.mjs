import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existingProfileAllowed, existingProfileHostBinary, saveExistingProfilePermission, configureExistingProfilePermission } from "./cua-profile-permission.mjs";

const platformTest = process.platform === "win32" ? test.skip : test;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "omb-chrome-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

platformTest("default, malformed, public and symlink policies never grant attachment", t => {
  const dir = fixture(t), policy = path.join(dir, "cua-existing-profile.json");
  assert.equal(existingProfileHostBinary("/fixture/driver", dir), "/fixture/driver");
  for (const body of ["{", '{"version":1,"allowed":"true"}', '{"version":2,"allowed":true}']) {
    fs.writeFileSync(policy, body, { mode: 0o600 });
    assert.equal(existingProfileAllowed(dir), false);
  }
  saveExistingProfilePermission(dir, true);
  fs.chmodSync(policy, 0o644);
  assert.equal(existingProfileAllowed(dir), false);
  fs.rmSync(policy);
  const other = path.join(dir, "other");
  fs.writeFileSync(other, '{"version":1,"allowed":true}', { mode: 0o600 });
  fs.symlinkSync(other, policy);
  assert.equal(existingProfileAllowed(dir), false);
});

platformTest("only an affirmative owner dialog saves the grant and requests restart", async t => {
  const dir = fixture(t);
  let restarts = 0, prompt;
  const request = response => configureExistingProfilePermission({ userData: dir, showMessageBox: async options => { prompt = options; return { response }; }, restart: () => restarts++ });
  assert.equal(await request(0), false);
  assert.equal(existingProfileAllowed(dir), false);
  assert.equal(restarts, 0);
  assert.equal(prompt.defaultId, 0);
  assert.match(prompt.detail, /USEAIだけに限定されません/);
  assert.equal(await request(1), true);
  assert.equal(existingProfileAllowed(dir), true);
  assert.equal(restarts, 1);
  assert.equal(await request(1), true);
  assert.equal(existingProfileAllowed(dir), false);
  assert.equal(restarts, 2);
});

platformTest("the SDK child execs the exact binary with one narrow startup grant, without unrestricted mode", t => {
  const dir = fixture(t), binary = path.join(dir, "fake 'driver");
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))`, { mode: 0o700 });
  saveExistingProfilePermission(dir, true);
  const wrapper = existingProfileHostBinary(binary, dir);
  const args = ["serve", "--embedded", "--socket", "/fixture/private socket"];
  assert.deepEqual(JSON.parse(execFileSync(wrapper, args, { encoding: "utf8" })), [...args, "--grant", "existing-profile"]);
  assert.throws(() => execFileSync(wrapper, ["mcp"], { stdio: "ignore" }));
  assert.equal(existingProfileHostBinary(binary, dir), wrapper);
  assert.equal(fs.readdirSync(dir).filter(file => file.startsWith("cua-profile-launch")).length, 1);
  saveExistingProfilePermission(dir, false);
  assert.equal(existingProfileHostBinary(binary, dir), binary);
});

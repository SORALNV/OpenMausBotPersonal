import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPersonalRuntime } from "./personal-runtime-verifier.mjs";

const id = "11111111-1111-4111-8111-111111111111", fingerprint = "1".repeat(40);
async function fixture(action) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "omb-runtime-test-"));
  const resources = join(root, "versions", id, "OpenMausBot Runtime.app", "Contents", "Resources");
  mkdirSync(resources, { recursive: true, mode: 0o700 });
  writeFileSync(join(resources, "app.asar"), "signed code", { mode: 0o600 });
  writeFileSync(join(root, "active.json"), JSON.stringify({ version: 1, id }), { mode: 0o600 });
  try { await action({ root, resources }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("pins runtime identity and signer before returning any code path", () => fixture(async ({ root, resources }) => {
  const calls = [];
  const result = await verifyPersonalRuntime({ root, fingerprint, verifySignature: (...args) => calls.push(args) });
  assert.equal(result.resources, resources);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /identifier "dev.sora.openmausbot.personal.runtime" and certificate leaf/);
}));
test("never returns executable code after a failed signature check", () => fixture(async ({ root }) => {
  await assert.rejects(() => verifyPersonalRuntime({ root, fingerprint, verifySignature: () => { throw Error("wrong certificate or modified runtime"); } }), /modified runtime/);
}));
test("rejects traversal, unknown fields and non-private activation files before signature checks", () => fixture(async ({ root }) => {
  for (const active of [{ version: 1, id: "../../evil" }, { version: 1, id, path: "/evil" }, { version: 2, id }]) {
    writeFileSync(join(root, "active.json"), JSON.stringify(active));
    await assert.rejects(() => verifyPersonalRuntime({ root, fingerprint, verifySignature: () => assert.fail("must not verify untrusted path") }));
  }
  writeFileSync(join(root, "active.json"), JSON.stringify({ version: 1, id }));
  chmodSync(join(root, "active.json"), 0o644);
  await assert.rejects(() => verifyPersonalRuntime({ root, fingerprint }));
}));
test("rejects symlinks, foreign ownership and a malformed signer", () => fixture(async ({ root, resources }) => {
  await assert.rejects(() => verifyPersonalRuntime({ root, fingerprint, uid: process.getuid() + 1 }));
  await assert.rejects(() => verifyPersonalRuntime({ root, fingerprint: "invalid" }));
  const archive = join(resources, "app.asar");
  rmSync(archive); symlinkSync("/tmp/code.asar", archive);
  await assert.rejects(() => verifyPersonalRuntime({ root, fingerprint }));
}));

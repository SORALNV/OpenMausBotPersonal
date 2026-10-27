import { test } from "node:test";
import assert from "node:assert/strict";
import { personalExecutableIdentity } from "./personal-app-identity.mjs";
const id = "dev.sora.openmausbot.personal";
function fixture() {
  const b = Buffer.alloc(96, 0x41); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(1, 16); b.writeUInt32LE(24, 20); b.writeUInt32LE(0x1b, 32); b.writeUInt32LE(24, 36); return b;
}
test("namespaces the build UUID and changes only its 16 bytes", () => {
  const before = fixture(), r = personalExecutableIdentity(before, id);
  assert.notDeepEqual(r.bytes.subarray(40, 56), before.subarray(40, 56));
  assert.deepEqual(r.bytes.subarray(0, 40), before.subarray(0, 40)); assert.deepEqual(r.bytes.subarray(56), before.subarray(56));
  assert.deepEqual(personalExecutableIdentity(r.bytes, id, r.marker).bytes, r.bytes);
  const runtime = personalExecutableIdentity(r.bytes, id + ".runtime", r.marker);
  assert.notEqual(runtime.uuid, r.uuid); assert.deepEqual(personalExecutableIdentity(runtime.bytes, id, runtime.marker).bytes, r.bytes);
});
test("rejects malformed executables, duplicate/missing UUIDs, and stale identity metadata", () => {
  const b = fixture();
  assert.throws(() => personalExecutableIdentity(Buffer.alloc(10), id));
  assert.throws(() => personalExecutableIdentity(b, "another-app"));
  const truncated=fixture(); truncated.writeUInt32LE(1000,20); assert.throws(() => personalExecutableIdentity(truncated,id));
  const missing=fixture(); missing.writeUInt32LE(2,32); assert.throws(() => personalExecutableIdentity(missing,id));
  const duplicate=fixture(); duplicate.writeUInt32LE(2,16); duplicate.writeUInt32LE(48,20); duplicate.copy(duplicate,56,32,56); assert.throws(() => personalExecutableIdentity(duplicate,id));
  const r=personalExecutableIdentity(b,id); r.bytes[40]^=1; assert.throws(() => personalExecutableIdentity(r.bytes,id,r.marker));
});

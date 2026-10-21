import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeAppVersion } from "./runtime-resources.mjs";

test("uses the signed runtime's version while leaving the stable launcher unchanged", () => {
  const key = Symbol.for("omb.personalRuntimeVersion");
  const before = globalThis[key];
  const app = { getVersion: () => "0.1.111" };
  try {
    delete globalThis[key];
    assert.equal(runtimeAppVersion(app), "0.1.111");
    globalThis[key] = "0.1.121";
    assert.equal(runtimeAppVersion(app), "0.1.121");
    assert.equal(app.getVersion(), "0.1.111");
  } finally {
    if (before === undefined) delete globalThis[key]; else globalThis[key] = before;
  }
});

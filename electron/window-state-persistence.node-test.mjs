import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWindowStatePersistence } from "./window-state-persistence.mjs";

test("persists and restores normal window bounds atomically on close", () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-window-state-"));
  const logs = [];
  try {
    const persistence = createWindowStatePersistence({ app: { getPath: () => directory }, log: line => logs.push(line) });
    assert.equal(persistence.readWindowState(), null);
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getNormalBounds: () => ({ x: 10, y: 20, width: 1100, height: 780 }), isMaximized: () => true,
      webContents: { send() {} },
    });
    persistence.installWindowStatePersistence(window);
    window.emit("move"); window.emit("close");
    const file = join(directory, "window-state.json");
    assert.deepEqual(persistence.readWindowState(), JSON.parse(readFileSync(file, "utf8")));
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.deepEqual(logs, []);
    writeFileSync(file, "invalid json");
    assert.equal(persistence.readWindowState(), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

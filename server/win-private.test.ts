// Through the loader a Windows machine must reach the built addon: the positive path is a
// file and directory the addon itself created, and the negative paths are what a guard must
// refuse — a default-DACL file, an oversized one, a foreign kind, a missing path. POSIX
// hosts have no Windows ACLs, so the loader is expected to stay null there.
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectPrivate, windowsPrivateFiles } from "./private-file.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "omb-win-private-")); roots.push(dir); return dir; };
const onWindows = process.platform === "win32" && windowsPrivateFiles !== null;

it.skipIf(!onWindows)("the addon creates and verifies its own private files on Windows", () => {
  const addon = windowsPrivateFiles!;
  const dir = fresh();
  expect(addon.createPrivate(dir, "directory", "")).toEqual({ ok: true });
  expect(inspectPrivate(dir, { kind: "directory", owner: true })).toMatchObject({ ok: true });

  const file = join(dir, "guarded.json");
  expect(addon.createPrivate(file, "file", '{"bindings":[]}')).toEqual({ ok: true });
  expect(inspectPrivate(file, { kind: "file", owner: true, singleLink: true, maxBytes: 1000 })).toMatchObject({ ok: true });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bindings: [] });

  // What the server's guards must refuse, and why:
  const shared = join(dir, "shared.json");
  writeFileSync(shared, "{}");
  expect(inspectPrivate(shared, { kind: "file" })).toMatchObject({ ok: false, rejection: "mode" });
  const fat = join(dir, "fat.json");
  addon.createPrivate(fat, "file", "x".repeat(64));
  expect(inspectPrivate(fat, { kind: "file", maxBytes: 8 })).toMatchObject({ ok: false, rejection: "size" });
  expect(inspectPrivate(file, { kind: "directory" })).toMatchObject({ ok: false, rejection: "kind" });
  expect(inspectPrivate(join(dir, "absent.json"), { kind: "file" })).toMatchObject({ ok: false, rejection: "missing" });
  const binary = join(dir, "bytes.bin");
  expect(addon.createPrivate(binary, "file", Buffer.from([0, 255, 1, 254]).toString("hex"), "hex")).toEqual({ ok: true });
  expect(readFileSync(binary)).toEqual(Buffer.from([0, 255, 1, 254]));
  try {
    symlinkSync(file, join(dir, "linked.json"));
    expect(inspectPrivate(join(dir, "linked.json"), { kind: "file" })).toMatchObject({ ok: false, rejection: "symlink" });
  } catch {
    // Making a symlink needs a privilege some CI users lack; the addon's reparse refusal then holds, untested here.
  }
});

it.skipIf(process.platform !== "win32")("a Windows machine without the built addon fails closed rather than pretending", () => {
  const dir = fresh();
  const file = join(dir, "guarded.json");
  writeFileSync(file, "{}");
  if (windowsPrivateFiles === null) {
    expect(inspectPrivate(file, { kind: "file", owner: true })).toMatchObject({ ok: false });
    expect(existsSync(file)).toBe(true);
  }
});

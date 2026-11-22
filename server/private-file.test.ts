import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectPrivate } from "./private-file.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "omb-private-file-")); roots.push(dir); return dir; };

const posix = it.skipIf(process.platform === "win32");
// The predicate is what Windows has no primitives for, so the passing cases are POSIX-only;
// the rejections a POSIX host can still produce (kind, symlink) hold everywhere else too.
posix("inspectPrivate accepts exactly what each guard requires", () => {
  const dir = fresh();
  const file = join(dir, "guarded.json");
  writeFileSync(file, "{}", { mode: 0o600 });
  expect(inspectPrivate(file, { kind: "file", owner: true, singleLink: true, maxBytes: 10 })).toEqual({ ok: true, stat: expect.anything() });
  expect(inspectPrivate(file, { maxBytes: 1 })).toMatchObject({ ok: false, rejection: "size" });
  expect(inspectPrivate(file, { kind: "directory" })).toMatchObject({ ok: false, rejection: "kind" });
  chmodSync(file, 0o644);
  expect(inspectPrivate(file, {})).toMatchObject({ ok: false, rejection: "mode" });
  chmodSync(file, 0o600);
  linkSync(file, join(dir, "second-name"));
  expect(inspectPrivate(file, { singleLink: true })).toMatchObject({ ok: false, rejection: "links" });
});
it("rejects a symlink without dereferencing it", () => {
  const dir = fresh();
  const outside = join(fresh(), "real.json");
  writeFileSync(outside, "{}", { mode: 0o600 });
  const link = join(dir, "guarded.json");
  symlinkSync(outside, link);
  expect(inspectPrivate(link, {})).toMatchObject({ ok: false, rejection: "symlink" });
});

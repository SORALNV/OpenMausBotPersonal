// The one owner-private file or directory predicate every local service's guard uses, so a
// platform port can only have a single shape to replace. POSIX keeps the lstat checks that
// Windows has no primitives for; there the addon (packages/win-private) verifies a held
// handle's owner and protected DACL, and a machine without the built addon fails closed.
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";

export type PrivateRejection = "kind" | "symlink" | "links" | "mode" | "owner" | "size" | "missing" | "unavailable";

export interface PrivateExpectation {
  /** Reject anything but this kind. */
  kind?: "file" | "directory";
  /** Require the process's own uid (the POSIX owner check). */
  owner?: boolean;
  /** Require exactly one link. */
  singleLink?: boolean;
  /** Reject content above this byte size. */
  maxBytes?: number;
}

export interface WindowsPrivateFiles {
  verifyPrivate(path: string, want: PrivateExpectation): { ok: true } | { ok: false; rejection: PrivateRejection };
  createPrivate(path: string, kind: "file" | "directory", content: string): { ok: true } | { ok: false; rejection: string };
}

function loadWindowsPrivateFiles(): WindowsPrivateFiles | null {
  if (process.platform !== "win32") return null;
  try {
    const found = createRequire(import.meta.url)("@openmausbot/win-private") as Partial<WindowsPrivateFiles>;
    return typeof found.verifyPrivate === "function" && typeof found.createPrivate === "function" ? (found as WindowsPrivateFiles) : null;
  } catch {
    return null;
  }
}

/** The addon's calls where it built, and null everywhere else. */
export const windowsPrivateFiles = loadWindowsPrivateFiles();

export function inspectPrivate(path: string, want: PrivateExpectation): { ok: true; stat?: Stats } | { ok: false; rejection: PrivateRejection } {
  if (windowsPrivateFiles) {
    const found = windowsPrivateFiles.verifyPrivate(path, want);
    return found.ok ? { ok: true } : { ok: false, rejection: found.rejection };
  }
  const stat = lstatSync(path);
  const rejection: PrivateRejection | null =
    (want.kind === "file" && !stat.isFile()) || (want.kind === "directory" && !stat.isDirectory()) ? "kind"
      : stat.isSymbolicLink() ? "symlink"
        : (want.singleLink && stat.nlink !== 1) ? "links"
          : (stat.mode & 0o077) !== 0 ? "mode"
            : (want.owner && stat.uid !== process.getuid?.()) ? "owner"
              : (want.maxBytes !== undefined && stat.size > want.maxBytes) ? "size"
                : null;
  return rejection ? { ok: false, rejection } : { ok: true, stat };
}

// node's chmod and mkdir cannot express an owner-only Windows file: the DACL that makes a
// file private is invisible to them, and the ACL rides the rename. The addon builds the
// descriptor instead; POSIX keeps mode bits in the plain fs calls.
export function ensurePrivateDir(dir: string): void {
  if (windowsPrivateFiles) {
    const made = windowsPrivateFiles.createPrivate(dir, "directory", "");
    if (!made.ok) throw new Error(`Private directory is unavailable: ${made.rejection}`);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function createPrivateFile(file: string, body: string): void {
  if (windowsPrivateFiles) {
    const made = windowsPrivateFiles.createPrivate(file, "file", body);
    if (!made.ok) throw new Error(`Private file is unavailable: ${made.rejection}`);
    return;
  }
  writeFileSync(file, body, { mode: 0o600, flag: "wx" });
}

export function writePrivateTemp(file: string, body: string): string {
  const temp = `${file}.${randomUUID()}.tmp`;
  createPrivateFile(temp, body);
  return temp;
}

// The one owner-private file or directory predicate every local service's guard uses, so a
// platform port (Windows has no POSIX mode or uid) can only have a single shape to replace.
import { lstatSync, type Stats } from "node:fs";

export type PrivateRejection = "kind" | "symlink" | "links" | "mode" | "owner" | "size";

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

export function inspectPrivate(path: string, want: PrivateExpectation): { ok: true; stat: Stats } | { ok: false; rejection: PrivateRejection } {
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

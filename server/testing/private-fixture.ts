import { writeFileSync } from "node:fs";
import { windowsPrivateFiles } from "../private-file.ts";

// A fixture pre-writes the file the app itself would own. On Windows a plain file is refused
// exactly like production refuses a tampered one, so the fixture writes through the addon's
// creator; elsewhere a 0600 file is that same thing. The value may be pre-encoded JSON text.
export function writePrivateJson(file: string, value: unknown): void {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  if (windowsPrivateFiles) {
    const made = windowsPrivateFiles.createPrivate(file, "file", body);
    if (!made.ok) throw new Error(`cannot create private fixture ${file}: ${made.rejection}`);
    return;
  }
  writeFileSync(file, body, { mode: 0o600 });
}

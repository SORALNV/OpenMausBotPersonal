import { rmSync, writeFileSync } from "node:fs";
import { windowsPrivateFiles } from "../private-file.ts";

// A fixture pre-writes the file the app itself would own; on Windows a plain file is refused
// like a tampered one, so this rides the addon's creator. Pass pre-encoded JSON text or a value.
export function writePrivateJson(file: string, value: unknown): void {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  if (windowsPrivateFiles) {
    rmSync(file, { force: true }); // the addon's creator only makes new files
    const made = windowsPrivateFiles.createPrivate(file, "file", body);
    if (!made.ok) throw new Error(`cannot create private fixture ${file}: ${made.rejection}`);
    return;
  }
  writeFileSync(file, body, { mode: 0o600 });
}

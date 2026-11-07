import { readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { saveImage } from "./attachments.ts";
import { nativeAttachmentInput, nativeImageContents } from "./native-attachments.ts";
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

it("loads only admitted image bytes, including image-only input, without editing originals", () => {
  const bytes = Buffer.from("synthetic image"), saved = saveImage(bytes, "image/png");
  const input = nativeAttachmentInput(`<attached-image path="${saved.path}" />`);
  expect(input.text).toBe("添付画像を確認してください。");
  expect(nativeImageContents(input.images)).toEqual([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);
  expect(readFileSync(saved.path)).toEqual(bytes);
  expect(nativeAttachmentInput("  exact text  ").text).toBe("  exact text  ");
});

it("rejects fabricated paths and unsupported files instead of sending attachment markers", () => {
  for (const text of ['<attached-image path="/tmp/123e4567-e89b-42d3-a456-426614174000.png" />', '<attached-file path="/private/file" />', '<attached-audio path="/private/audio" />']) expect(() => nativeAttachmentInput(text)).toThrow();
});

it("refuses a symlink swapped into an admitted attachment", () => {
  const saved = saveImage(Buffer.from("fixture"), "image/png");
  const input = nativeAttachmentInput(`<attached-image path="${saved.path}" />`);
  const other = `${saved.path}.target`; writeFileSync(other, "fixture"); unlinkSync(saved.path); symlinkSync(other, saved.path);
  expect(() => nativeImageContents(input.images)).toThrow();
});

it("refuses an oversized native image payload before encoding and keeps the original", () => {
  const saved = saveImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png");
  const input = nativeAttachmentInput(`<attached-image path="${saved.path}" />`);
  expect(() => nativeImageContents(input.images)).toThrow("5MB"); expect(readFileSync(saved.path).length).toBe(saved.bytes);
});

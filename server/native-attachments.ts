import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { TurnImageInput } from "./contracts.ts";
import { extractTurnImages } from "./turn-images.ts";

export function nativeAttachmentInput(raw: string): { text: string; images: TurnImageInput[] } {
  const input = extractTurnImages(raw);
  if (/<attached-(?:image|file|audio)\b|\[.*?\]\((?:attachment:|\/?api\/attachments\/)|data:(?:image|audio)\//iu.test(input.text)) throw Object.assign(Error("画像の添付を確認できないか、未対応のファイル形式です。画像を添付し直してください。"), { status: 400 });
  if (!input.text.trim() && !input.images.length) throw Object.assign(Error("メッセージまたは画像を指定してください。"), { status: 400 });
  return { text: input.text.trim() ? input.text : "添付画像を確認してください。", images: input.images };
}

/** Attachment paths are admitted by extractTurnImages; do not reopen a swapped symlink or read an unbounded file. */
export function nativeImageContents(images: readonly TurnImageInput[]): { type: "image"; data: string; mimeType: string }[] {
  if (images.reduce((sum, image) => sum + image.bytes, 0) > 5 * 1024 * 1024) throw Object.assign(Error("OhMyPiへ送る画像は合計5MB以内にしてください。元の画像は保持しています。"), { status: 413 });
  return images.map(image => {
    const fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size !== image.bytes || info.size <= 0 || info.size > 10 * 1024 * 1024) throw Error("添付画像が変更されています。添付し直してください。");
      const bytes = readFileSync(fd);
      if (bytes.length !== info.size) throw Error("添付画像の読み込み中に内容が変更されました。");
      return { type: "image" as const, data: bytes.toString("base64"), mimeType: image.mime };
    } finally { closeSync(fd); }
  });
}

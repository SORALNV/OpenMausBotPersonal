import { existsSync, readFileSync, renameSync } from "node:fs";
import { inspectPrivate, writePrivateTemp } from "./private-file.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";

type Receipt = { revisions: string[]; notice?: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = /^[a-f0-9]{64}$/;
export class GoogleChatReceipts {
  private file: string;
  private entries: Record<string, Receipt> = {};
  constructor(dir: string) {
    this.file = join(dir, "google-chat-receipts.json");
    if (!existsSync(this.file)) return;
    if (!inspectPrivate(this.file, { kind: "file", singleLink: true, maxBytes: 8_000_000 }).ok) throw new Error("Invalid Google Chat receipts");
    const saved = JSON.parse(readFileSync(this.file, "utf8"));
    if (saved.version !== 1 || !saved.entries || typeof saved.entries !== "object" || Array.isArray(saved.entries)) throw new Error("Invalid Google Chat receipts");
    for (const [key, value] of Object.entries(saved.entries) as [string, Receipt][]) {
      if (!hash.test(key) || !value || !Array.isArray(value.revisions) || value.revisions.some(revision => typeof revision !== "string" || !hash.test(revision))
        || (value.notice !== undefined && (typeof value.notice !== "string" || value.notice.length > 600))) throw new Error("Invalid Google Chat receipt");
      this.entries[key] = value;
    }
  }
  identify(destination: unknown, message: { id: string; text: string }) {
    const key = digest([destination, message.id]);
    const revision = digest(message.text.replace(/\r\n/g, "\n").trim());
    const previous = this.entries[key];
    return { key, revision, eventId: `google-chat:${key}:${revision}`, seen: previous?.revisions.includes(revision) ?? false, previousNotice: previous?.notice };
  }
  record(key: string, revision: string, notice?: string): void {
    const previous = this.entries[key];
    const receipt: Receipt = { revisions: [...new Set([...(previous?.revisions ?? []), revision])], ...(notice || previous?.notice ? { notice: notice ?? previous?.notice } : {}) };
    const entries = { ...this.entries, [key]: receipt };
    const json = JSON.stringify({ version: 1, entries });
    if (json.length > 8_000_000) throw new Error("Google Chat receipt storage is full");
    renameSync(writePrivateTemp(this.file, json), this.file);
    this.entries = entries;
  }
}

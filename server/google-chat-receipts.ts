import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 8_000_000) throw new Error("Invalid Google Chat receipts");
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
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, json, { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file);
    this.entries = entries;
  }
}

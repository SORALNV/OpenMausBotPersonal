import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LABELS, type PrivacyLabel, type ProtectedTerm } from "./rules.ts";
import { PrivacyBlocked } from "./policy.ts";

interface Entry extends ProtectedTerm { token: string; scope: string; scopes?: string[] }
export const TOKEN = /⟦(?:人物|住所|メール|電話|口座|秘密|URL|日付)_\d{3,}⟧/gu;

export class PrivacyVault {
  private readonly dir: string;
  private readonly file: string;
  private entries: Entry[];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new PrivacyBlocked("保護用ディレクトリにシンボリックリンクは使えません。");
    chmodSync(dir, 0o700);
    this.file = join(dir, "vault.json");
    try {
      if (existsSync(this.file) && (lstatSync(this.file).isSymbolicLink() || (lstatSync(this.file).mode & 0o077))) throw new Error();
      const data: unknown = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
      if (!Array.isArray(data) || data.some(e => !e || typeof e.text !== "string" || !e.text || typeof e.scope !== "string" || !Object.hasOwn(LABELS, e.label) || typeof e.token !== "string" || !/^⟦[^⟧]+_\d{3,}⟧$/u.test(e.token))) throw new Error();
      if (data.some(e => e.scopes !== undefined && (!Array.isArray(e.scopes) || e.scopes.some((s: unknown) => typeof s !== "string")))) throw new Error();
      if (data.length > 20_000 || new Set(data.map(e => e.text)).size !== data.length || new Set(data.map(e => e.token)).size !== data.length) throw new Error();
      if (data.some(e => !e.token.startsWith(`⟦${LABELS[e.label as PrivacyLabel]}_`) || Number(e.token.match(/_(\d+)⟧$/u)?.[1]) > 20_000 || Number(e.token.match(/_(\d+)⟧$/u)?.[1]) < 1)) throw new Error();
      this.entries = data;
    } catch { throw new PrivacyBlocked("ローカル対応表を読み込めません。送信は停止しています。"); }
  }

  known(_scope: string): ProtectedTerm[] {
    return this.entries.map(({ text, label }) => ({ text, label }));
  }

  terms(): ProtectedTerm[] {
    const path = join(this.dir, "terms.json");
    try {
      if (!existsSync(path)) return [];
      if (lstatSync(path).isSymbolicLink() || (lstatSync(path).mode & 0o077)) throw new Error();
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(data) || data.some(e => !e || typeof e.text !== "string" || !e.text || e.text.length > 1000 || !Object.hasOwn(LABELS, e.label))) throw new Error();
      return data;
    } catch { throw new PrivacyBlocked("保護語句ファイルが不正です。送信は停止しています。"); }
  }

  replace(scope: string, text: string, label: PrivacyLabel): string {
    const known = this.entries.find(e => e.text === text);
    if (known) {
      if (known.scope !== scope && !known.scopes?.includes(scope)) (known.scopes ??= []).push(scope);
      return known.token;
    }
    if (this.entries.length >= 20_000) throw new PrivacyBlocked("ローカル対応表の上限に達しました。送信は停止しています。");
    const number = this.entries.filter(e => e.label === label).reduce((max, e) => Math.max(max, Number(e.token.match(/_(\d+)⟧$/u)?.[1])), 0) + 1;
    const token = `⟦${LABELS[label]}_${String(number).padStart(3, "0")}⟧`;
    this.entries.push({ scope, text, label, token });
    return token;
  }

  commit(): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.entries), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } catch { throw new PrivacyBlocked("ローカル対応表を保存できません。送信は停止しています。"); }
  }

  /** Display only. Callers must never feed this result into model requests, tools, or logs. */
  hasToken(token: string): boolean { return this.entries.some(e => e.token === token); }

  restoreForDisplay(scope: string, text: string): string {
    const entries = new Map(this.entries.filter(e => e.scope === scope || e.scopes?.includes(scope)).map(e => [e.token, e.text]));
    return text.replace(TOKEN, token => entries.get(token) ?? token);
  }
}

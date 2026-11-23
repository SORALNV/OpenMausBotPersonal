import { chmodSync, existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PERSONAL_PRIVACY, PRIVACY_SOURCES, type PersonalPrivacySettings } from "../../shared/personal-privacy.ts";
import { PrivacyBlocked } from "./policy.ts";
import { createPrivateFile, ensurePrivateDir, inspectPrivate, writePrivateTemp } from "../private-file.ts";

export function validatePrivacySettings(value: unknown): PersonalPrivacySettings {
  const s = value as PersonalPrivacySettings;
  const bad = () => { throw new PrivacyBlocked("設定が不正です。置換名は重複せず80文字以内、表記は1件200文字以内で登録してください。"); };
  if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.enabled !== "boolean" || typeof s.allRoutines !== "boolean"
    || !Array.isArray(s.routineIds) || s.routineIds.length > 1000 || s.routineIds.some(id => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id))
    || !Array.isArray(s.sources) || s.sources.some(source => !PRIVACY_SOURCES.includes(source))
    || !Array.isArray(s.aliases) || s.aliases.length > 100) return bad();
  const variants = new Set<string>(); const replacements = new Set<string>();
  if (s.toolFiltering !== undefined && typeof s.toolFiltering !== "boolean") return bad();
  for (const group of s.aliases) {
    if (!group || typeof group.replacement !== "string" || !group.replacement.trim() || group.replacement !== group.replacement.trim()
      || group.replacement.length > 80 || /[⟦⟧\p{Cc}]/u.test(group.replacement) || /^(?:人物|住所|メール|電話|口座|秘密|URL|日付)_\d+$/u.test(group.replacement)
      || replacements.has(group.replacement) || !Array.isArray(group.variants) || !group.variants.length || group.variants.length > 50) return bad();
    replacements.add(group.replacement);
    if (group.restoreAs !== undefined && (typeof group.restoreAs !== "string" || !group.restoreAs.trim() || group.restoreAs.length > 200 || /[⟦⟧\p{Cc}]/u.test(group.restoreAs))) return bad();
    for (const variant of group.variants) {
      if (typeof variant !== "string" || !variant.trim() || variant !== variant.trim() || variant.length > 200 || /[⟦⟧\p{Cc}]/u.test(variant) || variants.has(variant)) return bad();
      variants.add(variant);
    }
  }
  return { enabled: s.enabled, allRoutines: s.allRoutines, routineIds: [...new Set(s.routineIds)], sources: [...new Set(s.sources)], aliases: s.aliases.map(g => ({ replacement: g.replacement, variants: [...g.variants], ...(g.restoreAs ? { restoreAs: g.restoreAs.trim() } : {}) })), toolFiltering: s.toolFiltering ?? false };
}

export class PrivacySettingsStore {
  private readonly file: string;
  constructor(dir: string) {
    ensurePrivateDir(dir);
    if (lstatSync(dir).isSymbolicLink()) throw new PrivacyBlocked("保護設定にシンボリックリンクは使えません。");
    chmodSync(dir, 0o700); this.file = join(dir, "settings.json");
  }
  read(): PersonalPrivacySettings {
    try {
      if (!existsSync(this.file)) return structuredClone(DEFAULT_PERSONAL_PRIVACY);
      if (!inspectPrivate(this.file, { kind: "file", singleLink: true, maxBytes: 2_000_000 }).ok) throw new Error();
      return validatePrivacySettings(JSON.parse(readFileSync(this.file, "utf8")));
    } catch { throw new PrivacyBlocked("Mac内の保護設定を読み込めません。対象データの送信を停止します。"); }
  }
  retireModelSetting(): void {
    if (!existsSync(this.file)) return;
    const settings = this.read();
    const previous = readFileSync(this.file, "utf8");
    if (!Object.hasOwn(JSON.parse(previous), "modelDetectionEnabled")) return;
    createPrivateFile(`${this.file}.before-model-removal-${randomUUID()}`, previous);
    this.save(settings);
  }
  save(value: unknown): PersonalPrivacySettings {
    const s = validatePrivacySettings(value);
    this.read();
    renameSync(writePrivateTemp(this.file, JSON.stringify(s)), this.file);
    return s;
  }
}

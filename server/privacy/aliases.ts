import type { PrivacyAlias } from "../../shared/personal-privacy.ts";
import type { PrivacyVault } from "./vault.ts";

export function mapPrivacyStrings(value: unknown, fn: (text: string) => string, depth = 0): unknown {
  if (depth > 32) throw new Error("Privacy payload too deep");
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map(v => mapPrivacyStrings(v, fn, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [fn(k), mapPrivacyStrings(v, fn, depth + 1)]));
  return value;
}

export function prepareAliases(scope: string, aliases: PrivacyAlias[], vault: PrivacyVault) {
  const output = new Map<string, string>();
  const variants = aliases.flatMap(group => group.variants.map(text => ({ text, group }))).sort((a, b) => b.text.length - a.text.length);
  const groups = new Map(variants.map(v => [v.text, v.group]));
  const pattern = variants.length ? new RegExp(variants.map(v => v.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu") : undefined;
  return {
    prepare(text: string): string {
      if (!pattern) return text;
      return text.split(/(⟦[^⟦⟧\r\n]{1,100}⟧)/u).map(part => vault.hasToken(part) ? part : part.replace(pattern, match => {
        const group = groups.get(match)!;
        const token = vault.registerAlias(scope, group.variants[0], group.replacement, group.restoreAs);
        output.set(token, `⟦${group.replacement}⟧`); return token;
      })).join("");
    },
    finish(text: string): string { return text.replace(/⟦[^⟦⟧\r\n]{1,100}⟧/gu, token => output.get(token) ?? token); },
  };
}

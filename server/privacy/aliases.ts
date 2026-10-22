import type { PrivacyAlias } from "../../shared/personal-privacy.ts";
import type { PrivacyVault } from "./vault.ts";

export function mapPrivacyStrings(value: unknown, fn: (text: string) => string, depth = 0, budget = { chars: 0, strings: 0 }): unknown {
  if (depth > 32) throw new Error("Replacement payload too deep");
  if (typeof value === "string") {
    budget.chars += value.length; budget.strings++;
    if (budget.chars > 100_000 || budget.strings > 16_384) throw new Error("Replacement payload too large");
    return fn(value);
  }
  if (Array.isArray(value)) return value.map(v => mapPrivacyStrings(v, fn, depth + 1, budget));
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Replacement requires JSON text");
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [mapPrivacyStrings(k, fn, depth + 1, budget), mapPrivacyStrings(v, fn, depth + 1, budget)]));
  }
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

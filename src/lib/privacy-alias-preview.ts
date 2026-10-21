import type { PrivacyAlias } from "../../shared/personal-privacy";

export function privacyAliasPreview(text: string, aliases: PrivacyAlias[]): { masked: string; restored: string } {
  aliases = aliases.map(group => ({ ...group, replacement: group.replacement.trim(), variants: group.variants.map(value => value.trim()).filter(Boolean) }));
  const entries = aliases.flatMap(group => group.variants.filter(Boolean).map(variant => ({ variant, group }))).sort((a, b) => b.variant.length - a.variant.length);
  if (!entries.length) return { masked: text, restored: text };
  const groups = new Map(entries.map(entry => [entry.variant, entry.group]));
  const pattern = new RegExp(entries.map(entry => entry.variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");
  const values = new Map(aliases.map(group => [`⟦${group.replacement}⟧`, group.restoreAs?.trim() || group.variants[0]]));
  const masked = text.split(/(⟦[^⟦⟧\r\n]{1,100}⟧)/u).map(part => values.has(part) ? part : part.replace(pattern, match => `⟦${groups.get(match)!.replacement || "置換先未設定"}⟧`)).join("");
  return { masked, restored: masked.replace(/⟦[^⟦⟧\r\n]{1,100}⟧/gu, token => values.get(token) ?? token) };
}

export const LABELS = {
  private_person: "人物", private_address: "住所", private_email: "メール", private_phone: "電話",
  account_number: "口座", secret: "秘密", private_url: "URL", private_date: "日付",
} as const;
export type PrivacyLabel = keyof typeof LABELS;
export interface PrivacySpan { start: number; end: number; label: PrivacyLabel }
export interface ProtectedTerm { text: string; label: PrivacyLabel }

const RULES: [PrivacyLabel, RegExp, number?][] = [
  ["private_email", /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu],
  ["private_phone", /(?<!\d)(?:\+81[- (]?[1-9]\d{0,3}|0\d{1,4})[- )]?\d{1,4}[- ]?\d{3,4}(?!\d)/gu],
  ["private_address", /(?:北海道|東京都|大阪府|京都府|[一-龯]{2,3}県)[^\s\n,，。、「」]{3,100}/gu],
  ["private_address", /\/(?:Users|home)\/[^\s/"'<>]+(?:\/[^\s"'<>]*)?/gu],
  ["private_person", /(?:氏名|名前|担当者|名義人|お名前)(?:は)?[\s:：=「]*([一-龯々ぁ-んァ-ヶー]+?(?:[ 　]+[一-龯々ぁ-んァ-ヶー]+?)?)(?=です|さん|様|[\s。、「」,，:：]|$)/gu, 1],
  ["private_person", /(?:私は|担当者は)([一-龯々]{2,12}(?:[ 　]+[一-龯々]{1,8})?)(?=です|さん|様|[。、「」\s]|$)/gu, 1],
  ["account_number", /(?:口座(?:番号)?|普通預金|当座預金|銀行口座)[\s:：=「]*(\d[\d -]{4,24}\d)/gu, 1],
  ["secret", /(?:sk[-_](?:proj[-_])?[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})/gu],
  ["secret", /(?:api[_ -]?key|access[_ -]?token|password|secret|パスワード|秘密鍵|APIキー)["']?\s*[:：=]\s*["'「]?([^\s"'」,，。}]+)/giu, 1],
  ["secret", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu],
];

export function literalSpans(text: string, terms: readonly ProtectedTerm[]): PrivacySpan[] {
  const spans: PrivacySpan[] = [];
  for (const term of terms) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(term.text, from);
      if (start < 0) break;
      spans.push({ start, end: start + term.text.length, label: term.label });
      from = start + term.text.length;
    }
  }
  return spans;
}

export function ruleSpans(text: string): PrivacySpan[] {
  const spans: PrivacySpan[] = [];
  for (const [label, pattern, group] of RULES) {
    for (const match of text.matchAll(pattern)) {
      const value = group ? match[group] : match[0];
      const start = match.index + (group ? match[0].lastIndexOf(value) : 0);
      spans.push({ start, end: start + value.length, label });
    }
  }
  return spans;
}

export function mergeSpans(spans: PrivacySpan[]): PrivacySpan[] {
  const merged: PrivacySpan[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (span.label === "secret") last.label = "secret";
    } else merged.push({ ...span });
  }
  return merged;
}

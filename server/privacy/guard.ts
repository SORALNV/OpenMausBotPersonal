import { LABELS, literalSpans, mergeSpans, ruleSpans, type PrivacySpan, type ProtectedTerm } from "./rules.ts";
import { PrivacyVault, TOKEN } from "./vault.ts";
import { PrivacyBlocked } from "./policy.ts";
import type { Detector } from "./detector.ts";

function outsideTokens(text: string, spans: PrivacySpan[], vault: PrivacyVault): PrivacySpan[] {
  const tokens = [...text.matchAll(TOKEN)].filter(m => vault.hasToken(m[0])).map(m => ({ start: m.index, end: m.index + m[0].length }));
  return spans.flatMap(span => {
    let parts = [span];
    for (const token of tokens) parts = parts.flatMap(s => s.end <= token.start || s.start >= token.end ? [s] : [
      ...(s.start < token.start ? [{ ...s, end: token.start }] : []),
      ...(s.end > token.end ? [{ ...s, start: token.end }] : []),
    ]);
    return parts;
  });
}

export class PrivacyGuard {
  readonly vault: PrivacyVault;
  private readonly detector: Detector;

  constructor(vault: PrivacyVault, detector: Detector) { this.vault = vault; this.detector = detector; }

  async protect(scope: string, payload: unknown, signal?: AbortSignal, mandatoryTerms: ProtectedTerm[] = []): Promise<unknown> {
    const texts: string[] = [];
    let length = 0;
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 32) throw new PrivacyBlocked("リクエストの構造が深すぎます。");
      if (typeof value === "string") {
        length += value.length;
        if (/^data:|;base64,|<attached-(?:image|file|audio|video)\b/i.test(value)) throw new PrivacyBlocked("厳格モード: 画像・音声・添付・バイナリは未対応です。");
        if (/(?:^|\s)[A-Za-z0-9+/]{256,}={0,2}(?=\s|$)/u.test(value)) throw new PrivacyBlocked("厳格モード: 長いエンコードデータは未対応です。");
        texts.push(value);
      } else if (Array.isArray(value)) value.forEach(v => collect(v, depth + 1));
      else if (value && typeof value === "object") {
        if (Object.getPrototypeOf(value) !== Object.prototype) throw new PrivacyBlocked("厳格モード: バイナリは未対応です。");
        const object = value as Record<string, unknown>;
        if (object.type !== undefined && !["text", "function"].includes(String(object.type))) throw new PrivacyBlocked("厳格モード: テキスト以外の入力は未対応です。");
        for (const [key, v] of Object.entries(object)) {
          if (/image|audio|video|file|attachment|base64/i.test(key)) throw new PrivacyBlocked("厳格モード: 添付・画像・音声は未対応です。");
          collect(key, depth + 1);
          collect(v, depth + 1);
        }
      } else if (value !== null && !["number", "boolean"].includes(typeof value)) throw new PrivacyBlocked();
      if (length > 100_000 || texts.length > 512) throw new PrivacyBlocked("保護できるリクエスト量の上限を超えました。");
    };
    collect(payload);
    signal?.throwIfAborted();
    const terms = [...mandatoryTerms, ...this.vault.terms(), ...this.vault.known(scope)];
    let detected: PrivacySpan[][];
    try { detected = await this.detector.detect(texts, signal); }
    catch { throw new PrivacyBlocked("ローカル検出に失敗しました。原文は送信していません。"); }
    if (!Array.isArray(detected) || detected.length !== texts.length) throw new PrivacyBlocked("ローカル検出結果が不正です。");
    const allSpans = texts.map((text, i) => {
      const spans = detected[i];
      if (!Array.isArray(spans) || spans.some(s => !s || !Object.hasOwn(LABELS, s.label) || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > text.length)) throw new PrivacyBlocked("ローカル検出範囲が不正です。");
      const merged = mergeSpans([...literalSpans(text, terms), ...ruleSpans(text), ...spans]);
      const pieces = outsideTokens(text, merged, this.vault);
      for (const span of pieces) this.vault.replace(scope, text.slice(span.start, span.end), span.label);
      return pieces;
    });
    const known = this.vault.known(scope);
    const protectedTexts = texts.map((text, i) => {
      const merged = outsideTokens(text, mergeSpans([...allSpans[i], ...literalSpans(text, known)]), this.vault);
      let result = "";
      let from = 0;
      for (const span of merged) {
        result += text.slice(from, span.start) + this.vault.replace(scope, text.slice(span.start, span.end), span.label);
        from = span.end;
      }
      return result + text.slice(from);
    });
    let index = 0;
    const rebuild = (value: unknown): unknown => {
      if (typeof value === "string") return protectedTexts[index++];
      if (Array.isArray(value)) return value.map(rebuild);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([, v]) => [protectedTexts[index++], rebuild(v)]));
      return value;
    };
    const result = rebuild(payload);
    this.vault.commit();
    signal?.throwIfAborted();
    return result;
  }

  close(): void { this.detector.close(); }
}

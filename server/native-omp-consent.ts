export type NativeConsentCommand = "grant" | "revoke";

/** Only a standalone owner control message can grant permission; quoted native/tool output is never parsed. */
export function nativeConsentCommand(text: string): NativeConsentCommand | undefined {
  const line = text.normalize("NFKC").trim().replace(/[。.!！]+$/u, "").replace(/\s+/gu, "");
  if (/^(?:(?:この|今回の)(?:依頼|作業|操作)(?:は|を|について)?)?(?:すべて|全て|全部|すべての操作|全ての操作)(?:を)?許可(?:します|する|して|で進めて)?$/u.test(line)) return "grant";
  if (/^(?:(?:すべて|全て|全部)許可(?:の|を)?)?(?:取り消し|取消し|取り消す|取消す|取り消して|解除|解除して|撤回|撤回します)$|^(?:通常の確認に戻して|高リスクは確認して)$/u.test(line)) return "revoke";
  return undefined;
}

export function nativeAuditText(text: string): string {
  return Array.from(text).filter(char => char === "\n" || char === "\t" || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|Bearer\s+[\w.~-]+)/giu, "[秘密情報]")
    .replace(/((?:token|password|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/giu, "$1[非表示]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[非表示]@")
    .slice(0, 1800);
}

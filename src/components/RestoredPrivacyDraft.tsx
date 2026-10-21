import { useState } from "react";
import { useCopyFeedback } from "@/lib/copy-text";

export function RestoredPrivacyDraft({ text, onClose }: { text: string; onClose(): void }) {
  const [draft, setDraft] = useState(text);
  const copy = useCopyFeedback(draft);
  return <section aria-label="復元した下書き" className="my-3 space-y-2 rounded-lg border border-hairline p-3">
    <h3>復元した下書き</h3>
    <p className="text-xs text-ink-secondary">編集・コピー専用です。AIへの再送信やGoogle Chatへの投稿は行いません。閉じると下書きを破棄します。</p>
    <textarea aria-label="復元した下書きの本文" value={draft} onChange={event => setDraft(event.target.value)} className="min-h-32 w-full rounded-lg border border-hairline bg-inset p-2" />
    <button type="button" onClick={() => void copy.copy()}>{copy.state === "copied" ? "コピーしました" : copy.state === "failed" ? "コピーできませんでした" : "下書きをコピー"}</button>
    <button type="button" onClick={onClose}>下書きを閉じる</button>
  </section>;
}

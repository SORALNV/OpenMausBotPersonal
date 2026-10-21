import { useState } from "react";
import { useCopyFeedback } from "@/lib/copy-text";
import { RestoredPrivacyDraft } from "./RestoredPrivacyDraft";

export function PrivacyText({ text, threadId }: { text: string; threadId?: string }) {
  const [display, setDisplay] = useState<{ source: string; threadId?: string; value: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ source: string; threadId?: string }>();
  const restored = display?.source === text && display.threadId === threadId ? display.value : undefined;
  const copy = useCopyFeedback(restored ?? "");
  const restore = async () => {
    setBusy(true);
    setError("");
    try {
      const endpoint = import.meta.env.VITE_OMB_PERSONAL === "1" ? `/api/threads/${encodeURIComponent(threadId ?? "")}/privacy/display` : "/api/privacy/display";
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, threadId }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { text: string };
      setDisplay({ source: text, threadId, value: body.text });
    } catch { setError("ローカル表示を復元できませんでした。"); }
    finally { setBusy(false); }
  };
  return <div>
    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{restored ?? text}</div>
    {threadId && text.includes("⟦") && <button type="button" disabled={busy} onClick={() => restored ? setDisplay(undefined) : void restore()}>
      {busy ? "復元中…" : restored ? "仮名表示に戻す" : "このMac内だけで表示を復元"}
    </button>}
    {restored && <p>表示専用の復元です。送信・ツール実行には適用しません。</p>}
    {restored && <button type="button" onClick={() => void copy.copy()}>{copy.state === "copied" ? "コピーしました" : copy.state === "failed" ? "コピーできませんでした" : "確認した復元文をコピー"}</button>}
    {restored && <button type="button" onClick={() => setDraft({ source: text, threadId })}>復元した下書きを作る</button>}
    {restored && draft?.source === text && draft.threadId === threadId && <RestoredPrivacyDraft key={`${threadId}:${text}`} text={restored} onClose={() => setDraft(undefined)} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}

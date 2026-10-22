import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function PrivacyWorkbench({ threadId, onApply }: { threadId: string; onApply(text: string): void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" disabled={!threadId} onClick={() => setOpen(true)} className="rounded-lg px-3 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">仮名化して入力</button>
    {open && <MaskDialog key={threadId} threadId={threadId} onClose={() => setOpen(false)} onApply={onApply} />}
  </>;
}

function MaskDialog({ threadId, onApply, onClose }: { threadId: string; onApply(text: string): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [raw, setRaw] = useState("");
  const [protectedText, setProtectedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => request.current?.abort();
  }, []);
  const mask = async () => {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setProtectedText("");
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/privacy/mask`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: raw }), signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { text: string };
      if (typeof body.text !== "string" || !body.text.trim()) throw new Error();
      if (!controller.signal.aborted) setProtectedText(body.text);
    } catch {
      if (!controller.signal.aborted) setError("仮名化できませんでした。原文はAIへ送信していません。");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} onCancel={onClose} className="m-auto max-h-[90dvh] w-[min(680px,95vw)] overflow-y-auto rounded-2xl border border-hairline bg-panel p-5 text-ink shadow-2xl backdrop:bg-black/60">
    <h2 className="text-lg font-semibold">Mac内で仮名化してから入力</h2>
    <p className="my-3 text-sm text-ink-secondary">登録した置換ルールだけをこのMacで適用します。未登録の氏名やメールなどは検出しません。原文は通常の下書き・会話履歴に保存せず、対応表はMac内に保存します。</p>
    <label className="block text-sm">原文<textarea autoFocus value={raw} disabled={busy} maxLength={100000} onChange={e => { setRaw(e.target.value); setProtectedText(""); }} className="mt-1 min-h-36 w-full rounded-lg border border-hairline bg-card p-3" /></label>
    <button type="button" disabled={busy || !raw.trim()} onClick={() => void mask()} className="my-3 rounded-lg bg-accent px-4 py-2 text-accent-ink disabled:opacity-50">{busy ? "Mac内で処理中…" : "仮名化する"}</button>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {protectedText && <label className="block text-sm">送る前に確認・修正<textarea value={protectedText} onChange={e => setProtectedText(e.target.value)} className="mt-1 min-h-36 w-full rounded-lg border border-hairline bg-card p-3" /></label>}
    <p className="my-3 text-xs text-ink-secondary">登録していない表記はそのまま残ります。添付ファイル、Codexが直接読むファイル、ツールの通信はこの機能の対象外です。</p>
    <div className="flex justify-end gap-3">
      <button type="button" onClick={onClose} className="rounded-lg border border-hairline px-4 py-2">閉じる</button>
      <button type="button" disabled={!protectedText.trim() || busy} onClick={() => { onApply(protectedText); onClose(); }} className="rounded-lg bg-accent px-4 py-2 text-accent-ink disabled:opacity-50">確認した文章を入力欄へ</button>
    </div>
  </dialog>, document.body);
}

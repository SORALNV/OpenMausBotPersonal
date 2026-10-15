export function PrivacySetup({ busy, recheck }: { busy: boolean; recheck(): Promise<void> }) {
  return <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
    <div className="max-w-[560px] rounded-2xl border border-hairline/40 bg-card p-6">
      <h1 className="text-[20px] font-semibold text-ink">保護する AI 接続を設定してください</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-secondary">この開発版はテキスト専用の API 接続を使います。既存アプリのキーやログインは読み込みません。</p>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-secondary">開発用の接続先とモデルを設定し、専用の <code>OMB_PRIVACY_API_KEY</code> を指定して再起動してください。手順は <code>docs/privacy-filter.md</code> にあります。</p>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-secondary">CLI・ブラウザ操作・外部ツール・音声・添付は厳格モードでは使えません。</p>
      <button type="button" disabled={busy} onClick={() => void recheck()} className="mt-5 rounded-lg bg-raised px-3 py-2 text-[14px] text-ink disabled:opacity-60">{busy ? "確認中…" : "接続状態を再確認"}</button>
    </div>
  </main>;
}

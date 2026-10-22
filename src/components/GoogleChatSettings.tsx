import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

type Diagnostic = { stage: string; startedAt: string; endedAt?: string; code?: string; elapsedMs?: number };
type Status = { enabled: boolean; botId?: string; threadId?: string; state: string; cursor: number; diagnostics?: { body?: Diagnostic | null; poll?: Diagnostic | null } };
type Bot = { id: string; name: string; threadId: string; hidden?: boolean };
export function GoogleChatSettings() {
  const [status, setStatus] = useState<Status>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<number>();
  useEffect(() => {
    let active = true;
    void Promise.all([api<Status>("/api/google-chat"), api<{ bots: Bot[] }>("/api/bots?messages=0")]).then(([s, list]) => {
      if (!active) return;
      setStatus(s); setBots(list.bots.filter(bot => !bot.hidden)); setBotId(s.botId ?? list.bots.find(bot => bot.name === "予定管理人")?.id ?? "");
    }).catch(() => { if (active) setError("Google Chatの設定を読み込めません。"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!status?.enabled) return;
    let active = true;
    const timer = setInterval(() => { void api<Status>("/api/google-chat").then(value => { if (active) setStatus(value); }).catch(() => { if (active) setError("接続状態を確認できません。"); }); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [status?.enabled]);
  const change = async (connect: boolean) => {
    setBusy(true); setError("");
    try {
      const bot = bots.find(bot => bot.id === botId);
      if (connect && !bot) throw new Error("届け先のボットを選んでください。");
      setStatus(await api<Status>(connect ? "/api/google-chat/connect" : "/api/google-chat", {
        method: connect ? "POST" : "PUT", body: JSON.stringify(connect ? { botId, threadId: bot!.threadId } : { enabled: false }),
      }));
    } catch { setError("接続を変更できません。監視サーバー、大学ログイン、登録語句の置換設定を確認してください。"); }
    finally { setBusy(false); }
  };
  const check = async () => {
    setChecking(true); setError(""); setChecked(undefined);
    try {
      const value = await api<Status & { check: { messages: number } }>("/api/google-chat/check", { method: "POST", body: "{}", timeoutMs: 140000 });
      setStatus(value); setChecked(value.check.messages);
    } catch {
      setError("本文診断に失敗しました。取得原文はAIへ送信していません。診断の停止段階と失敗コードを確認してください。");
      try { setStatus(await api<Status>("/api/google-chat")); } catch { /* Preserve the existing diagnostic state. */ }
    } finally { setChecking(false); }
  };
  return <Card title="Google Chat連携" subtitle="監視専用ブラウザの新着を受け取り、返信を頼んだときだけ送信します。">
    <div className="space-y-3">
      <p className="text-sm text-ink-secondary">対象は監視サーバーに登録したスレッドだけです。取得本文は登録語句だけをこのMacで置換します。未登録の個人情報は自動検出しません。受信だけでAIや返信を起動しません。</p>
      <label className="block text-sm">新着を届けるボット<select aria-label="Google Chat接続先" className="mt-1 block w-full rounded-lg border border-hairline bg-inset p-2" value={botId} disabled={busy || !status} onChange={event => setBotId(event.target.value)}>
        <option value="">ボットを選ぶ</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select></label>
      <p role="status" className="text-sm">{busy ? "接続を設定中…" : status?.enabled ? `監視接続: ${status.state} / 受信位置 ${status.cursor}` : "未接続・停止中"}</p>
      {status?.enabled && <p className="text-sm">本文取得・マスク: {status.diagnostics?.body ? `${status.diagnostics.body.endedAt ? status.diagnostics.body.code === "OK" ? "完了" : "失敗" : "処理中"} / ${status.diagnostics.body.stage} / ${status.diagnostics.body.code ?? "待機"}${status.diagnostics.body.elapsedMs !== undefined ? ` / ${(status.diagnostics.body.elapsedMs / 1000).toFixed(1)}秒` : ""}` : "未確認（接続正常だけでは本文取得の成功を意味しません）"}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="rounded-lg bg-accent px-4 py-2 text-accent-ink" disabled={busy || checking || !status || !botId} onClick={() => void change(true)}>Google Chatを接続</button>
        <button type="button" className="rounded-lg border border-hairline px-4 py-2" disabled={busy || checking || !status?.enabled} onClick={() => void change(false)}>Google Chatの受信を停止</button>
        <button type="button" className="rounded-lg border border-hairline px-4 py-2" disabled={busy || checking || !status?.enabled} onClick={() => void check()}>本文取得を診断</button></div>
      {checking && <p role="status" className="text-sm">本文を取得・マスクしています。最大135秒。AIへの送信やGoogle Chatへの投稿は行いません。</p>}
      {checked !== undefined && <p role="status" className="text-sm">本文取得・ローカルマスク完了: {checked}件（AIへ未送信）</p>}
      <p className="text-xs text-ink-secondary">接続情報はMac内で読み込み、画面やAIには渡しません。停止するとこのボットへの新着受信とGoogle Chatツールの組込みを止めます。</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Card>;
}

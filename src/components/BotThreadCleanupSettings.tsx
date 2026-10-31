import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";
type Policy = { enabled: boolean; idleHours: number };
export function BotThreadCleanupSettings() {
  const [policy, setPolicy] = useState<Policy>();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { let live = true; void api<Policy>("/api/bot-thread-cleanup").then(value => { if (live) setPolicy(value); }).catch(() => { if (live) setMessage("自動整理の設定を読み込めません。"); }); return () => { live = false; }; }, []);
  const save = async () => {
    if (!policy) return;
    setBusy(true);
    try { setPolicy(await api<Policy>("/api/bot-thread-cleanup", { method: "PUT", body: JSON.stringify(policy) })); setMessage("保存しました。再起動せずに次の定期確認から反映されます。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存できません。"); }
    finally { setBusy(false); }
  };
  return <Card title="Botスレッドの自動整理" subtitle="Botが作成した未使用のスレッドを10分ごとに確認し、アーカイブします。履歴は残ります。">
    <fieldset disabled={!policy || busy} className="space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" aria-label="Botスレッドを自動整理" checked={policy?.enabled ?? false} onChange={event => policy && setPolicy({ ...policy, enabled: event.target.checked })} />自動整理を有効にする</label>
      <label className="block">未使用期間（時間）<input type="number" aria-label="Botスレッドの未使用時間" min={1} max={720} value={policy?.idleHours ?? 24} onChange={event => policy && setPolicy({ ...policy, idleHours: Number(event.target.value) })} /></label>
      <p className="text-xs">人間が作成・昇格したスレッド、ピン留め、実行中・承認待ち、最近開いた会話、NativeConnectなどの明示的な接続先は残します。整理したスレッドの未読通知は解除します。</p>
      <button type="button" onClick={() => void save()}>自動整理の設定を保存</button>
      <button type="button" onClick={() => { setBusy(true); void api<{ archived: number }>("/api/bot-thread-cleanup/run", { method: "POST" }).then(result => setMessage(`${result.archived}件をアーカイブしました。`)).catch(() => setMessage("整理を完了できませんでした。")).finally(() => setBusy(false)); }}>今すぐ未使用スレッドを整理</button>
    </fieldset>{message && <p role="status">{message}</p>}
  </Card>;
}

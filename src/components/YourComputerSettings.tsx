import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";

type Snapshot = { enabled: boolean; deviceId: string; deviceName: string; scope: string[] };
type Confirmation = { confirmationId: string; deviceId: string; deviceName: string; scope: string[]; expiresInMs: number };

export function YourComputerSettings() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => setState(await api<Snapshot>("/api/your-computer/settings"));
  useEffect(() => { void refresh().catch(() => setError("このPCの許可状態を読み込めません。所有者の設定権限を確認してください。")); }, []);

  const requestEnable = async () => {
    setBusy(true); setError(""); setNotice("");
    try { setConfirmation(await api<Confirmation>("/api/your-computer/confirmation", { method: "POST", body: "{}" })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "確認を開始できません。"); }
    finally { setBusy(false); }
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await api<Snapshot>("/api/your-computer/settings", { method: "PUT", body: JSON.stringify({ enabled, ...(enabled ? { confirmationId: confirmation?.confirmationId } : {}) }) });
      setState(next); setConfirmation(null); setNotice(enabled ? "このPCの全Botに適用しました。" : "このPCの常時許可を解除しました。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "設定を保存できません。"); if (enabled) setConfirmation(null); }
    finally { setBusy(false); }
  };

  return <Card title="このPCの操作許可" subtitle="このPCを使う全Botに適用します。許可はこのOpenMausBotのPCだけに保存されます。">
    <div className="space-y-3">
      {state ? <>
        <div className="flex items-center justify-between gap-4 text-sm">
          <div><p className="font-medium">このPC操作を常時許可する</p><p className="text-ink-secondary">対象PC：{state.deviceName} · {state.deviceId.slice(0, 8)}</p></div>
          <div className="flex items-center gap-3"><span className="text-xs text-ink-secondary">{state.enabled ? "許可中" : "オフ"}</span>
            <Switch aria-label="このPC操作を常時許可する" disabled={busy} checked={state.enabled} onClick={() => state.enabled ? void setEnabled(false) : void requestEnable()} />
          </div>
        </div>
        <p className="text-xs text-ink-secondary">対象：画面の表示、クリック、キー・文字入力、スクロール、アプリの起動・切替</p>
        <p className="text-xs text-ink-secondary">メッセージ送信、購入、削除などの承認と、サインイン確認は引き続き必要です。</p>
      </> : <p className="text-sm text-ink-secondary">読み込み中…</p>}

      {confirmation && <div role="dialog" aria-label="このPCの常時許可を確認" className="space-y-3 rounded-lg border border-hairline bg-inset p-3">
        <p className="text-sm font-medium">このPCを常時許可しますか？</p>
        <p className="text-sm">対象PC：{confirmation.deviceName} · {confirmation.deviceId.slice(0, 8)}</p>
        <p className="text-xs text-ink-secondary">許可する操作：{confirmation.scope.join("、")}。この設定は同じPCを使う全Botに適用され、別のPCには引き継がれません。</p>
        <p className="text-xs text-ink-secondary">送信・購入・削除などの承認とサインイン確認は省略しません。</p>
        <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void setEnabled(true)} className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink">このPCを常時許可</button>
          <button type="button" disabled={busy} onClick={() => setConfirmation(null)} className="rounded-lg border border-hairline px-3 py-2 text-sm">キャンセル</button></div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Card>;
}

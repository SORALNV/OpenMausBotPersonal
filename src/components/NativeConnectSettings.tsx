import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

type Settings = { enabled: boolean; model: string; models: { id: string; name: string }[]; active: number };

export function NativeConnectSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let current = true; void api<Settings>("/api/native-connect").then(value => { if (current) setSettings(value); }, () => { if (current) setMessage("接続設定を取得できません。"); }); return () => { current = false; }; }, []);
  const refresh = async () => {
    setBusy(true); setMessage("");
    try { setSettings(await api<Settings>("/api/native-connect/models", { method: "POST", timeoutMs: 65000, body: "{}" })); }
    catch (error) { setMessage(error instanceof Error ? error.message : "モデルを取得できません。"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!settings) return;
    setBusy(true); setMessage("");
    try { setSettings(await api<Settings>("/api/native-connect", { method: "PUT", timeoutMs: 65000, body: JSON.stringify({ enabled: settings.enabled, model: settings.model }) })); setMessage("委託設定を保存しました。次のBotのターンから反映されます。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存できません。"); }
    finally { setBusy(false); }
  };
  const options = settings && !settings.models.some(model => model.id === settings.model)
    ? [{ id: settings.model, name: settings.model }, ...settings.models] : settings?.models ?? [];
  return <Card title="NativeConnect / Antigravityへの委託" subtitle="Botのモデル・役割・記憶はそのまま。必要な作業だけをAntigravityに任せ、Botが結果を読み取って返答します。">
    <fieldset disabled={busy || !settings} className="space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" aria-label="Antigravityへの委託を有効化" checked={settings?.enabled ?? false} onChange={event => setSettings(value => value && { ...value, enabled: event.target.checked })} />Antigravityへの委託を有効にする</label>
      <label className="block text-sm">委託先のモデル<select className="mt-1 w-full rounded-lg border border-hairline bg-inset p-2 text-sm" aria-label="Antigravityの委託先モデル" value={settings?.model ?? ""} onChange={event => setSettings(value => value && { ...value, model: event.target.value })}>
        {options.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg border border-hairline px-3 py-2 text-sm disabled:opacity-50" onClick={() => void refresh()}>CLIのモデル一覧を取得</button>
        <button className="rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink disabled:opacity-50" onClick={() => void save()}>Antigravityへの委託設定を保存</button>
      </div>
    </fieldset>
    <p className="text-xs text-ink-secondary">通常の相談やOMBの操作はBotが担当します。実作業の委託はフルアクセスの個別チャットで利用でき、会話ごとに同じAntigravityセッションを継続します。CLI自身の許可設定を維持します。画像転送・CLIの対話承認・人間との同時入力は未対応です。</p>
    {message && <p role="status" className="text-xs text-ink-secondary">{message}</p>}
  </Card>;
}

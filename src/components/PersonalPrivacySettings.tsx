import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";
import { DEFAULT_PERSONAL_PRIVACY, PRIVACY_SOURCES, type PersonalPrivacySettings as Settings } from "../../shared/personal-privacy";
import { privacyAliasPreview } from "@/lib/privacy-alias-preview";

const sourceNames = { custom: "登録したMCPの取得結果", browser: "組み込みブラウザの取得結果", composio: "Connected Appsの取得結果", data: "Dataツールの取得結果" };
type Snapshot = { settings: Settings; state: "off" | "loading" | "ready" | "error" };
const inputClass = "mt-1 w-full rounded-lg border border-hairline bg-inset p-2 text-sm";
export function PersonalPrivacySettings() {
  const [settings, setSettings] = useState<Settings>(structuredClone(DEFAULT_PERSONAL_PRIVACY));
  const [status, setStatus] = useState<Snapshot["state"]>("off");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sample, setSample] = useState("");
  const preview = privacyAliasPreview(sample, settings.aliases);
  const [routines, setRoutines] = useState<{ id: string; name: string; runOn: string; target: string }[]>([]);
  useEffect(() => {
    let active = true;
    void Promise.all([api<Snapshot>("/api/privacy/settings"), api<{ routines: typeof routines }>("/api/routines")]).then(([snapshot, list]) => {
      if (!active) return;
      setSettings(snapshot.settings); setStatus(snapshot.state); setRoutines(list.routines); setLoaded(true);
    }).catch(() => { if (active) setError("保護設定を読み込めません。所有者の設定権限で開いてください。"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (status !== "loading") return;
    let active = true;
    const timer = setInterval(() => {
      void api<Snapshot>("/api/privacy/settings").then(snapshot => { if (active) setStatus(snapshot.state); }).catch(() => { if (active) setStatus("error"); });
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [status]);
  const change = (patch: Partial<Settings>) => { setSettings(s => ({ ...s, ...patch })); setMessage(""); };
  const save = async () => {
    setSaving(true); setError(""); setMessage("");
    try {
      const normalized = { ...settings, aliases: settings.aliases.map(g => ({ replacement: g.replacement.trim(), variants: g.variants.map(v => v.trim()).filter(Boolean), ...(g.restoreAs?.trim() ? { restoreAs: g.restoreAs.trim() } : {}) })) };
      const snapshot = await api<Snapshot>("/api/privacy/settings", { method: "PUT", body: JSON.stringify(normalized) });
      setSettings(snapshot.settings); setStatus(snapshot.state); setMessage("保存しました。次のツール接続・対象の定期実行から適用します。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "設定を保存できません。"); }
    finally { setSaving(false); }
  };
  return <Card title="個人情報の自動マスク" subtitle="通常のチャットはそのまま。取得ツールと定期実行の結果を、AIに返す前にこのMacで仮名化します。">
    <fieldset disabled={!loaded || saving} className="space-y-4">
      <label className="flex items-center justify-between gap-4"><span>OpenAI Privacy Filterの自動検出（Google Chatを含む）</span><Switch aria-label="Privacy Filterの自動検出" checked={settings.modelDetectionEnabled !== false} onClick={() => change({ modelDetectionEnabled: settings.modelDetectionEnabled === false })} /></label>
      <p className="text-xs text-ink-secondary">オフにすると、Google Chatを含む取得結果と手動の仮名化でモデル・補助ルールによる自動検出を停止します。自分で登録した置換ルールは残り、未登録の氏名・メールなどは置換されません。</p>
      <label className="flex items-center justify-between gap-4"><span>取得ツールでローカルフィルターを使えるようにする</span><Switch aria-label="取得ツールのローカルフィルター" checked={settings.toolFiltering ?? false} onClick={() => change({ toolFiltering: !settings.toolFiltering })} /></label>
      <p className="text-xs text-ink-secondary">有効にすると、登録したMCPなどの取得ツールにマスク付き取得の選択肢を追加します。「個人情報をマスクしてGoogle Chatを取得して」などの依頼で使います。原文を取得した後、AIに返す前にこのMacで処理します。登録語句の置換は対象ツールの結果に常時適用し、OpenAI privacy-filterはツールの選択時と下の定期実行設定で使います。通常のチャット本文へは一律適用しません。</p>
      <label className="flex items-center justify-between gap-4"><span>定期実行のセキュリティフィルターを有効にする</span><Switch aria-label="定期実行のセキュリティフィルター" checked={settings.enabled} onClick={() => change({ enabled: !settings.enabled })} /></label>
      <p role="status" className="text-xs text-ink-secondary">モデル: {status === "loading" ? "Mac内で読込中…" : status === "ready" ? "Mac内で準備完了" : status === "error" ? "準備・検出に失敗（対象結果は遮断）" : "停止中"}</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.allRoutines} onChange={e => change({ allRoutines: e.target.checked })} />このMacで実行するすべてのボット定期実行に適用</label>
      {!settings.allRoutines && <div className="space-y-2">
        {routines.filter(r => r.runOn !== "cloud" && r.target !== "room-goal").map(r => <label key={r.id} className="flex gap-2 text-sm"><input type="checkbox" checked={settings.routineIds.includes(r.id)} onChange={e => change({ routineIds: e.target.checked ? [...settings.routineIds, r.id] : settings.routineIds.filter(id => id !== r.id) })} />{r.name}</label>)}
        {!routines.some(r => r.runOn !== "cloud" && r.target !== "room-goal") && <p className="text-sm text-ink-secondary">対象にできるボット定期実行がありません。</p>}
      </div>}
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">自動適用する取得経路</legend>{PRIVACY_SOURCES.map(source => <label key={source} className="flex gap-2 text-sm"><input type="checkbox" checked={settings.sources.includes(source)} onChange={e => change({ sources: e.target.checked ? [...settings.sources, source] : settings.sources.filter(s => s !== source) })} />{sourceNames[source]}</label>)}</fieldset>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">自分で登録する置換ルール</h3>
        <p className="text-xs text-ink-secondary">漢字・ひらがな・英語などを1行ずつ登録すると、すべて同じ仮名になります。大文字・小文字と空白も一致する表記を登録してください。復元表記を空欄にすると先頭の表記を使います。</p>
        {settings.aliases.map((group, index) => <div key={index} className="rounded-lg border border-hairline p-3">
          <label className="block text-sm">置換先 {index + 1}<input aria-label={`置換先 ${index + 1}`} maxLength={80} value={group.replacement} placeholder="ユーザーA" className={inputClass} onChange={e => change({ aliases: settings.aliases.map((g, i) => i === index ? { ...g, replacement: e.target.value } : g) })} /></label>
          <label className="mt-2 block text-sm">置換する表記 {index + 1}<textarea aria-label={`置換する表記 ${index + 1}`} value={group.variants.join("\n")} placeholder={"星野架空\nほしのかくう\nKaku Hoshino"} rows={3} className={inputClass} onChange={e => change({ aliases: settings.aliases.map((g, i) => i === index ? { ...g, variants: e.target.value.split("\n") } : g) })} /></label>
          <label className="mt-2 block text-sm">元に戻す際の表記 {index + 1}<input aria-label={`元に戻す際の表記 ${index + 1}`} maxLength={200} value={group.restoreAs ?? ""} placeholder={group.variants[0] || "星野架空"} className={inputClass} onChange={e => change({ aliases: settings.aliases.map((g, i) => i === index ? { ...g, restoreAs: e.target.value } : g) })} /></label>
          <p className="mt-2 break-words text-xs text-ink-secondary">{group.variants.filter(Boolean).join(" / ") || "登録した表記"} → ⟦{group.replacement || "ユーザーA"}⟧</p>
          <button type="button" className="mt-2 text-sm text-danger" onClick={() => change({ aliases: settings.aliases.filter((_, i) => i !== index) })}>このルールを削除</button>
        </div>)}
        <button type="button" disabled={settings.aliases.length >= 100} className="rounded-lg border border-hairline px-3 py-2 text-sm" onClick={() => change({ aliases: [...settings.aliases, { replacement: "", variants: [""] }] })}>置換ルールを追加</button>
      </div>
      <label className="block text-sm">置換ルールを試す<textarea aria-label="置換ルールを試す" value={sample} maxLength={10000} onChange={e => setSample(e.target.value)} rows={3} className={inputClass} placeholder="ここに試し入力すると、下に置換後と復元後を表示します。" /></label>
      {sample && <div className="space-y-2 text-sm"><p>AIに渡す表記（登録語句のみ）</p><pre className="whitespace-pre-wrap break-words rounded-lg bg-inset p-3">{preview.masked}</pre><p>復元する下書きの表記</p><pre className="whitespace-pre-wrap break-words rounded-lg bg-inset p-3">{preview.restored}</pre></div>}
      <p className="text-xs text-ink-secondary">自動検出がオンの対象では、未登録の個人情報をローカルのOpenAI privacy-filterと補助ルールで検出します。検出漏れは残ります。オンの対象での失敗・タイムアウトや画像・音声などの未対応結果は原文をAIへ渡しません。</p>
      <p className="text-xs text-ink-secondary">Codex等が直接読むファイル・ブラウザ・CLI独自通信、CLIにだけ登録したMCP、通常の会話・既存履歴・記憶、添付、クラウド実行、チーム目標や別ボットへの委任は自動適用の対象外です。登録した置換ルールは手動の「仮名化して入力」でも使えます。</p>
      <button type="button" onClick={() => void save()} className="rounded-lg bg-accent px-4 py-2 text-accent-ink">{saving ? "保存中…" : "マスク設定を保存"}</button>
    </fieldset>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </Card>;
}

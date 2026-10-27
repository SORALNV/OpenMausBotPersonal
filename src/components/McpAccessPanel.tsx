import { useState } from "react";
import { api, useStore } from "@/state/store";

type Tool = { name: string; description?: string };
type Rule = { fingerprint: string; managers: string[]; targets: string[]; tools: string[]; grants: Record<string, string[]> };
type Audit = { at: number; actor: string; target: string; server: string; tools: string[]; reason: string };
const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];

export function McpAccessPanel({ server, onSaved }: { server: string; onSaved?: () => void }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
  const [policyRevision, setPolicyRevision] = useState("");
  const [catalog, setCatalog] = useState<Tool[]>([]), [revision, setRevision] = useState("");
  const [managers, setManagers] = useState<string[]>([]), [targets, setTargets] = useState<string[]>([]), [tools, setTools] = useState<string[]>([]), [grants, setGrants] = useState<Record<string, string[]>>({});
  const [audit, setAudit] = useState<Audit[]>([]);
  const bots = state.bots.filter(bot => !bot.hidden);
  const load = async () => {
    setOpen(true); setBusy(true); setError(undefined); setSaved(false);
    try {
      const checked = await api(`/api/mcp/access/${server}/catalog`);
      const rule = checked.rule as Rule | undefined;
      setManagers(rule?.managers ?? []); setTargets(rule?.targets ?? []); setTools(rule?.tools ?? []); setGrants(rule?.grants ?? {});
      setCatalog(checked.tools); setRevision(checked.revision); setPolicyRevision(checked.policyRevision); setAudit(checked.audit);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(undefined); setSaved(false);
    try {
      const result = await api(`/api/mcp/access/${server}`, { method: "PUT", body: JSON.stringify({ revision, policyRevision, managers, targets, tools,
        grants: Object.entries(grants).filter(([botId]) => targets.includes(botId)).map(([botId, selected]) => ({ botId, tools: selected.filter(t => tools.includes(t)) })) }) });
      setAudit(result.audit.filter((a: Audit) => a.server === server)); setPolicyRevision(result.policyRevision); setSaved(true); onSaved?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setError(undefined); setSaved(false);
    try { await api(`/api/mcp/access/${server}`, { method: "DELETE" }); setManagers([]); setTargets([]); setGrants({}); setSaved(true); onSaved?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="mt-3 border-t border-hairline pt-3">
    <button type="button" className="rounded-lg bg-control px-3 py-2 text-[13px]" onClick={() => open ? setOpen(false) : void load()} aria-expanded={open}>{server} のBot別権限・Managerへの委任</button>
    {open && <div className="mt-3 space-y-3 text-[13px]">
      <p>本人がツールの上限・管理者・対象Botを決めます。管理者はこの範囲内だけで配布・解除できます。共通スイッチがオフでも、配布されたBotだけが使えます。この設定を保存すると、このMCPの従来の一括配布は使われなくなります。</p>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {saved && <p role="status" className="text-success">Bot別の権限設定を保存しました。配布先の次のターンから利用できます。</p>}
      {busy && <p role="status">確認中…</p>}
      <fieldset disabled={busy || !revision} className="space-y-3">
        <legend className="font-medium">本人が許可するツールの上限</legend>
        {catalog.map(tool => <label key={tool.name} className="flex items-start gap-2"><input type="checkbox" checked={tools.includes(tool.name)} onChange={() => { setTools(toggle(tools, tool.name)); setSaved(false); }} aria-label={`上限: ${tool.name}`} /><span><code>{tool.name}</code><span className="block text-ink-secondary">{tool.description}</span></span></label>)}
      </fieldset>
      <fieldset disabled={busy || !revision}><legend className="font-medium">権限の配布を任せるBot</legend>
        {bots.map(bot => <label key={bot.id} className="mr-3 inline-flex items-center gap-1"><input type="checkbox" aria-label={`管理者: ${bot.name}`} checked={managers.includes(bot.id)} onChange={() => { setManagers(toggle(managers, bot.id)); setSaved(false); }} />{bot.name}</label>)}
      </fieldset>
      <fieldset disabled={busy || !revision} className="space-y-2"><legend className="font-medium">配布の対象Botと初期権限</legend>
        <p className="text-ink-secondary">「対象」は配布できる範囲です。初期付与は個別に選びます。選ばなければ、管理者が配布するまで使えません。</p>
        {bots.map(bot => <div key={bot.id} className="rounded border border-hairline p-2"><label className="flex gap-2"><input type="checkbox" aria-label={`対象: ${bot.name}`} checked={targets.includes(bot.id)} onChange={() => { setTargets(toggle(targets, bot.id)); setSaved(false); }} />{bot.name}</label>
          {targets.includes(bot.id) && <div className="ml-5 mt-1 flex flex-wrap gap-2">{tools.map(tool => <label key={tool} className="flex gap-1"><input type="checkbox" aria-label={`初期付与: ${bot.name}: ${tool}`} checked={grants[bot.id]?.includes(tool) ?? false} onChange={() => { setGrants({ ...grants, [bot.id]: toggle(grants[bot.id] ?? [], tool) }); setSaved(false); }} /><code>{tool}</code></label>)}</div>}
        </div>)}
      </fieldset>
      <div className="flex gap-2"><button type="button" disabled={busy || !revision || !tools.length} onClick={() => void save()} className="rounded bg-control px-3 py-2">{server} の委任・初期権限を保存</button><button type="button" disabled={busy} onClick={() => void stop()} className="rounded bg-control px-3 py-2">{server} の委任・配布を停止</button><button type="button" disabled={busy} onClick={() => void load()}>再読込</button></div>
      <p className="text-ink-secondary">接続先・認証が変わると委任は無効になります。上限外のツールは管理者自身では追加できません。シェルやファイルへのアクセス権は別設定です。</p>
      {audit.length > 0 && <details><summary>権限変更の履歴（{audit.length}件）</summary>{audit.slice(-30).reverse().map((a, i) => <p key={i}>{new Date(a.at).toLocaleString()} / {a.actor === "owner" ? "本人" : bots.find(b => b.id === a.actor)?.name ?? a.actor} → {a.target === "policy" ? "上限設定" : bots.find(b => b.id === a.target)?.name ?? a.target}：{a.tools.join("、") || "解除"} — {a.reason}</p>)}</details>}
    </div>}
  </div>;
}

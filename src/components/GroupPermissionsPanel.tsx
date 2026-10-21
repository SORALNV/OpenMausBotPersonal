import { useEffect, useRef, useState } from "react";
import { api, useStore, type Group } from "@/state/store";
import { groupMemberPermissions, type GroupMemberPermissions, type GroupPermissions } from "../../shared/group-permissions";

export function GroupPermissionsPanel({ group, onClose }: { group: Group; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [permissions, setPermissions] = useState<GroupPermissions>(() => ({ crossSection: group.permissions?.crossSection ?? false,
    members: Object.fromEntries(group.memberIds.map(id => [id, { ...groupMemberPermissions(group, id) }])) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const base = useRef({ version: group.permissionsVersion ?? 0, members: group.memberIds.join(",") });
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const savingRef = useRef(saving); savingRef.current = saving;
  useEffect(() => {
    const node = dialog.current;
    const focusables = () => [...node!.querySelectorAll<HTMLElement>('button:not([disabled]), input, select')];
    focusables()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) closeRef.current();
      if (event.key !== "Tab") return;
      const controls = focusables(); const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    node?.addEventListener("keydown", key);
    return () => node?.removeEventListener("keydown", key);
  }, []);
  const patchMember = (id: string, patch: Partial<GroupMemberPermissions>) => setPermissions(p => ({ ...p, members: { ...p.members, [id]: { ...p.members[id], ...patch } } }));
  const save = async () => {
    if (base.current.members !== group.memberIds.join(",")) { setError("メンバーが変更されました。一度閉じて開き直してください。"); return; }
    setSaving(true); setError("");
    try {
      const result = await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ permissions, permissionsVersion: base.current.version }) });
      dispatch({ type: "groupPatched", group: result.group }); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "設定を保存できませんでした。"); }
    finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onMouseDown={e => { if(e.target === e.currentTarget && !saving) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={`${group.name} のグループ設定`} className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-2xl border border-hairline bg-card p-4 shadow-2xl">
      <h2 className="text-lg font-semibold">グループ設定</h2><p className="mb-3 text-sm text-ink-secondary">{group.name}</p>
      <div className="min-h-0 space-y-3 overflow-y-auto">
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={permissions.crossSection} onChange={e => setPermissions(p => ({ ...p, crossSection: e.target.checked }))} />カテゴリーをまたいだメンバー間の連携を許可</label>
        <p className="text-xs text-ink-secondary">端末管理部・無所属などの分類に関係なく、このグループの参加者同士で連携します。非参加Botや個別チャットへの権限は増えません。</p>
        {group.memberIds.map(id => {
          const bot = state.bots.find(b => b.id === id); const p = permissions.members[id];
          return <fieldset key={id} aria-label={`${bot?.name ?? id} の権限`} className="rounded-xl border border-hairline p-3">
            <legend className="px-1 text-sm font-semibold">{bot?.name ?? id} <span className="font-normal text-ink-secondary">{bot?.section || "無所属"}</span></legend>
            <label className="flex flex-wrap items-center justify-between gap-2 text-sm">会話への反応<select aria-label={`${bot?.name ?? id} の応答方法`} className="rounded-lg border border-hairline bg-raised px-2 py-1" value={p.response} onChange={e => patchMember(id, { response: e.target.value as GroupMemberPermissions["response"] })}>
              <option value="inherit">グループの応答設定に従う</option><option value="mentions">メンションされたときだけ</option><option value="always">メンションなしでも反応</option><option value="off">発言しない（閲覧のみ）</option>
            </select></label>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <label className="flex gap-2"><input type="checkbox" checked={p.post} onChange={e => patchMember(id, { post: e.target.checked })} />自発的な投稿</label>
              <label className="flex gap-2"><input type="checkbox" checked={p.mention} onChange={e => patchMember(id, { mention: e.target.checked })} />他Botをメンションで呼ぶ</label>
              <label className="flex gap-2"><input type="checkbox" checked={p.coordinate} onChange={e => patchMember(id, { coordinate: e.target.checked })} />他Botへ作業を依頼</label>
            </div>
          </fieldset>;
        })}
        <p className="text-xs text-ink-secondary">自発応答は新しいメッセージへの反応です。無限の会話を防ぐ回数制限、個別Botの連絡先制限、ツール操作の承認は引き続き適用されます。</p>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {group.working && <p className="mt-2 text-sm text-ink-secondary">作業が終わるか停止してから保存してください。</p>}
      <div className="mt-4 flex justify-end gap-2"><button disabled={saving} className="rounded-lg bg-raised px-4 py-2" onClick={onClose}>キャンセル</button><button disabled={saving || group.working} className="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40" onClick={() => void save()}>{saving ? "保存中…" : "設定を保存"}</button></div>
    </div>
  </div>;
}

import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";
import type { DirectCodexSettings as Settings } from "../../shared/direct-codex";

type Bot = { id: string; name: string; threadId: string; tasks?: { threadId: string; title: string }[] };
type Snapshot = { settings: Settings; states: Record<string, string>; sharedConnectedThreads?: string[] };
export function DirectCodexSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<{ id: string; name: string }[]>([]);
  const [locked, setLocked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([api<Snapshot>("/api/direct-codex"), api<{ bots: Bot[] }>("/api/bots?messages=0")]).then(([value, list]) => {
      if (active) { setSnapshot(value); setLocked(value.settings.bindings.map(b => b.threadId)); setBots(list.bots); }
    }).catch(() => { if (active) setMessage("固定Codex接続の設定を読み込めません。"); });
    return () => { active = false; };
  }, []);
  const update = (index: number, patch: Partial<Settings["bindings"][number]>) => setSnapshot(s => s && ({ ...s, settings: { bindings: s.settings.bindings.map((b, i) => i === index ? { ...b, ...patch } : b) } }));
  const request = async (method: "PUT" | "POST") => {
    if (!snapshot) return;
    setBusy(true); setMessage("");
    try {
      const value = await api<Snapshot>("/api/direct-codex", { method, body: JSON.stringify(snapshot.settings), timeoutMs: 120000 });
      setSnapshot(value); setLocked(value.settings.bindings.map(b => b.threadId)); setMessage(method === "PUT" ? "保存しました。次の送信から反映します。" : "同期状態を更新しました。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "接続設定を変更できません。"); }
    finally { setBusy(false); }
  };
  return <Card title="Codexセッションへの接続" subtitle="Botのスレッドごとに、接続先のCodex会話を固定します。">
    <p className="text-xs text-ink-secondary">Codex側のモデル・履歴・承認設定を使います。入力の仲介は原文を残して整理メモを添え、回答の短縮は表示だけを変えます。共有接続ではChatGPTアプリも同じサーバーへ接続して起動し、同じ会話と承認を扱います。アプリ専用ツールにはChatGPTアプリの接続が必要です。従来の単独接続は、ChatGPTアプリが会話を保持していると競合します。添付、定期実行、差し込みには対応していません。</p>
    <fieldset disabled={!snapshot || busy} className="space-y-3">
      <button type="button" onClick={() => { setBusy(true); void api<{ threads: typeof threads }>("/api/direct-codex/threads").then(value => setThreads(value.threads)).catch(() => setMessage("Codexの会話一覧を取得できません。")).finally(() => setBusy(false)); }}>Codexの会話一覧を読み込む</button>
      {snapshot?.settings.bindings.map((binding, index) => <div key={index} className="space-y-2 rounded-lg border border-hairline p-3">
        <label className="flex justify-between">この接続を有効にする<Switch aria-label={`固定接続 ${index + 1}`} checked={binding.enabled} onClick={() => update(index, { enabled: !binding.enabled })} /></label>
        <label className="block">Bot<select aria-label={`接続元Bot ${index + 1}`} disabled={locked.includes(binding.threadId)} value={binding.botId} onChange={e => { const bot = bots.find(b => b.id === e.target.value); update(index, { botId: bot?.id ?? "", threadId: bot?.threadId ?? "" }); }}><option value="">選択</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <label className="block">Botのスレッド<select aria-label={`接続元スレッド ${index + 1}`} disabled={locked.includes(binding.threadId)} value={binding.threadId} onChange={e => update(index, { threadId: e.target.value })}>{(bots.find(bot => bot.id === binding.botId)?.tasks ?? []).map(task => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}<option value={binding.threadId}>{binding.threadId || "選択"}</option></select></label>
        <label className="block">Codexの会話ID<input aria-label={`Codex会話ID ${index + 1}`} disabled={locked.includes(binding.threadId)} value={binding.codexThreadId} onChange={e => update(index, { codexThreadId: e.target.value })} /></label>
        {!!threads.length && !locked.includes(binding.threadId) && <select aria-label={`Codex会話を選択 ${index + 1}`} value={binding.codexThreadId} onChange={e => update(index, { codexThreadId: e.target.value })}><option value="">選択</option>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.name}</option>)}</select>}
        <label className="flex justify-between">入力を仲介モデルで整理する<Switch aria-label={`入力の仲介 ${index + 1}`} checked={Boolean(binding.mediator)} onClick={() => update(index, { mediator: binding.mediator ? undefined : { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 60000 } })} /></label>
        {binding.mediator && <><label className="block">仲介プロバイダー<input aria-label={`仲介プロバイダー ${index + 1}`} value={binding.mediator.providerId} onChange={e => update(index, { mediator: { ...binding.mediator!, providerId: e.target.value } })} /></label><label className="block">仲介モデル<input aria-label={`仲介モデル ${index + 1}`} value={binding.mediator.modelId} onChange={e => update(index, { mediator: { ...binding.mediator!, modelId: e.target.value } })} /></label></>}
        <label className="flex justify-between">表示だけ短く整える<Switch aria-label={`回答の短縮 ${index + 1}`} checked={Boolean(binding.formatter)} onClick={() => update(index, { formatter: binding.formatter ? undefined : { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 60000 } })} /></label>
        {binding.formatter && <><label className="block">整形プロバイダー<input aria-label={`整形プロバイダー ${index + 1}`} value={binding.formatter.providerId} onChange={e => update(index, { formatter: { ...binding.formatter!, providerId: e.target.value } })} /></label><label className="block">整形モデル<input aria-label={`整形モデル ${index + 1}`} value={binding.formatter.modelId} onChange={e => update(index, { formatter: { ...binding.formatter!, modelId: e.target.value } })} /></label></>}
        <p className="text-xs">接続状態: {snapshot.states[binding.threadId] ?? "未確認"}</p>
        <p className="text-xs">接続方式: {snapshot.sharedConnectedThreads?.includes(binding.threadId) ? "共有サーバーに接続中" : "共有接続は未確認"}</p>
        <button type="button" onClick={() => setSnapshot(s => s && ({ ...s, settings: { bindings: s.settings.bindings.filter((_, i) => i !== index) } }))}>この接続を削除</button>
      </div>)}
      <button type="button" onClick={() => setSnapshot(s => s && ({ ...s, settings: { bindings: [...s.settings.bindings, { botId: "", threadId: "", codexThreadId: "", hostId: "local", enabled: false }] } }))}>固定接続を追加</button>
      <button type="button" onClick={() => void request("PUT")}>Codex接続を保存</button>
      <button type="button" onClick={() => void request("POST")}>Codex側の入力・回答を同期</button>
    </fieldset>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </Card>;
}

import { useState } from "react";
import { api } from "@/state/store";
import type { NativeOmpBinding } from "../../shared/native-omp";

export function NativeDshDestination({ bindings, bots, onSaved }: { bindings: NativeOmpBinding[]; bots: { id: string; name: string }[]; onSaved: () => Promise<unknown> }) {
  const [botId, setBotId] = useState("");
  const [host, setHost] = useState("192.168.11.43");
  const [user, setUser] = useState("jetson");
  const [cwd, setCwd] = useState("/home/jetson/web");
  const [model, setModel] = useState("openai-codex/gpt-6.1-sol");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const live = await api<{ bindings: NativeOmpBinding[] }>("/api/native-omp");
      if (live.bindings.some(binding => binding.botId === botId)) throw Error("このBotには既に接続設定があります。");
      const binding: NativeOmpBinding = { botId, enabled: true, harness: "deepseek", connection: "shared-web", host, user,
        binary: `/home/${user}/.local/bin/dsh`, stateRoot: `/home/${user}/.local/state/omb-dsh`, profile: "web", cwd, model, approvalPolicy: "mediator",
        mediator: { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 60000 }, formatter: { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 60000 } };
      await api("/api/native-omp", { method: "PUT", body: JSON.stringify({ bindings: [...live.bindings, binding] }) });
      await onSaved(); setMessage("接続先を保存しました。Botを選び、共有セッションを作成・接続できます。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存できません。"); }
    finally { setBusy(false); }
  };
  return <details><summary>DeepseekHarness の接続先を追加</summary>
    <p>家庭内LANのSSHで標準Web版に接続します。接続先にOMB用のWebサービスを準備してください。</p>
    <fieldset disabled={busy} className="space-y-2">
      <label className="block">接続するBot<select aria-label="DSH接続のBot" value={botId} onChange={event => setBotId(event.target.value)}><option value="">選択</option>{bots.filter(bot => !bindings.some(binding => binding.botId === bot.id)).map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <label className="block">LANのIPアドレス<input aria-label="DSH接続先IP" value={host} onChange={event => setHost(event.target.value)} /></label>
      <label className="block">SSHユーザー<input aria-label="DSH SSHユーザー" value={user} onChange={event => setUser(event.target.value)} /></label>
      <label className="block">Jetson上の作業フォルダー<input aria-label="DSH作業フォルダー" value={cwd} onChange={event => setCwd(event.target.value)} /></label>
      <label className="block">新規セッションのモデル<input aria-label="DSHモデル" value={model} onChange={event => setModel(event.target.value)} /></label>
      <button type="button" disabled={!botId || !host || !user} onClick={() => void save()}>DeepseekHarnessの接続先を保存</button>
    </fieldset>{message && <p role="status">{message}</p>}
  </details>;
}

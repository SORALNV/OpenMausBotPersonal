import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import type { NativeOmpBinding, NativeOmpSessionInfo, NativeOmpThreadTarget } from "../../shared/native-omp";

type Bot = { id: string; name: string; threadId: string; tasks?: { threadId: string; title: string }[] };
type Snapshot = { bindings: NativeOmpBinding[]; threadTargets: Record<string, NativeOmpThreadTarget>; sessionIds: Record<string, string>; states: Record<string, string> };
const statusLabel = (value?: string) => ({ idle: "待機中", "human-working": "標準TUIで実行中", "waiting-on-you": "確認待ち", preparing: "仲介処理中", working: "実行中", disconnected: "未接続", reconnecting: "再接続中" }[value ?? ""] ?? (value?.startsWith("not-sent:") ? "接続前に停止（入力は未送信）" : "未確認"));
export function NativeOmpSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [sessions, setSessions] = useState<NativeOmpSessionInfo[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [kind, setKind] = useState<"manager" | "session">("session");
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("none");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const creation = useRef<{ botId: string; name: string; requestId: string; session?: NativeOmpSessionInfo } | null>(null);
  const connection = useRef<{ key: string; requestId: string } | null>(null);
  const reload = async () => {
    const [state, list] = await Promise.all([api<Snapshot>("/api/native-omp"), api<{ bots: Bot[] }>("/api/bots?messages=0")]);
    setSnapshot(state); setBots(list.bots);
    return { state, bots: list.bots };
  };
  useEffect(() => {
    let active = true;
    void Promise.all([api<Snapshot>("/api/native-omp"), api<{ bots: Bot[] }>("/api/bots?messages=0")]).then(([state, list]) => {
      if (!active) return;
      setSnapshot(state); setBots(list.bots);
      const selected = state.bindings.find(value => value.enabled)?.botId ?? "";
      setBotId(selected); setThreadId(list.bots.find(bot => bot.id === selected)?.threadId ?? "");
    }).catch(() => { if (active) setMessage("OMP接続設定を読み込めません。"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setSessionId(snapshot?.threadTargets?.[threadId]?.session.id ?? snapshot?.sessionIds?.[threadId] ?? "");
    setKind(snapshot?.threadTargets?.[threadId]?.kind ?? "session");
  }, [snapshot, threadId]);
  const work = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : "OMPの操作に失敗しました。"); }
    finally { setBusy(false); }
  };
  const loadSessions = async () => {
    setMessage("OMPセッション一覧を取得しています。");
    const result = await api<{ sessions: NativeOmpSessionInfo[] }>(`/api/native-omp/sessions?botId=${encodeURIComponent(botId)}&threadId=${encodeURIComponent(threadId)}`, { timeoutMs: 130000 });
    setSessions(result.sessions); setMessage(`${result.sessions.length}件のセッションを取得しました。`);
  };
  const save = () => work(async () => {
    setMessage("OMPへの共有接続を準備・確認しています。");
    const result = await api<{ threadId: string; session: NativeOmpSessionInfo }>("/api/native-omp/threads", { method: "POST", timeoutMs: 130000, body: JSON.stringify({ botId, threadId, kind, ...(sessionId ? { sessionId } : {}) }) });
    await reload(); setMessage(`「${result.session.name}」に接続しました。`);
  });
  const create = () => work(async () => {
    if (!creation.current || creation.current.name !== name.trim() || creation.current.botId !== botId) creation.current = { botId, name: name.trim(), requestId: crypto.randomUUID() };
    const request = creation.current;
    setMessage("名前付きのOMPセッションを作成・保存しています。");
    if (!request.session) request.session = (await api<{ session: NativeOmpSessionInfo }>("/api/native-omp/sessions", { method: "POST", timeoutMs: 130000, body: JSON.stringify({ botId, threadId, name: request.name, requestId: request.requestId }) })).session;
    const session = request.session;
    setSessions(values => [...values.filter(value => value.id !== session.id), session]);
    if (destination !== "none") {
      setMessage("セッションを保存しました。共有接続を準備・確認しています。");
      const key = JSON.stringify([botId, threadId, destination, session.id]);
      if (connection.current?.key !== key) connection.current = { key, requestId: crypto.randomUUID() };
      const result = await api<{ threadId: string; session: NativeOmpSessionInfo }>("/api/native-omp/threads", { method: "POST", timeoutMs: 130000,
        body: JSON.stringify({ botId, threadId, kind: "session", sessionId: session.id, ...(destination === "new-thread" ? { newThreadTitle: request.name, requestId: connection.current.requestId } : {}) }) });
      await reload(); setThreadId(result.threadId); setMessage(`「${session.name}」を作成し、${destination === "new-thread" ? "新しい" : "この"}OMBスレッドへ接続しました。`);
    } else setMessage(`「${session.name}」を作成・保存しました。接続先は変更していません。`);
    creation.current = null; connection.current = null;
  });
  return <Card title="OhMyPi / NativeConnect" subtitle="OMBスレッドとPiのセッションを選んで接続します。標準OhMyPi TUIと同じ会話を使います。">
    <p className="text-xs text-ink-secondary">「OMP全体」は、このBotで設定したOMPプロファイル内のセッション一覧・作成・接続を扱う管理接続です。別プロジェクトの会話履歴は混ぜません。チャットからも、名前付きセッションの作成や、新しいOMBスレッドへの接続を依頼できます。</p>
    <fieldset disabled={busy || !snapshot} className="space-y-3">
      <label className="block">Bot<select aria-label="OMP接続のBot" value={botId} onChange={event => { setBotId(event.target.value); setThreadId(bots.find(bot => bot.id === event.target.value)?.threadId ?? ""); setSessions([]); }}>
        <option value="">選択</option>{bots.filter(bot => snapshot?.bindings.some(binding => binding.enabled && binding.botId === bot.id)).map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select></label>
      <label className="block">OMBスレッド<select aria-label="OMP接続のスレッド" value={threadId} onChange={event => setThreadId(event.target.value)}>
        <option value="">選択</option>{bots.find(bot => bot.id === botId)?.tasks?.map(task => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}
      </select></label>
      <button type="button" disabled={!threadId} onClick={() => void work(loadSessions)}>OMPセッション一覧を読み込む</button>
      <label className="block">接続方式<select aria-label="OMP接続方式" value={kind} onChange={event => setKind(event.target.value as "session" | "manager")}>
        <option value="session">一つのOMPセッションに固定</option><option value="manager">OMP全体（セッション管理）</option>
      </select></label>
      <label className="block">{kind === "manager" ? "管理会話として使うセッション" : "接続するOMPセッション"}<select aria-label="OMPセッション" value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">現在の会話を使う</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.name} — {session.id.slice(0, 8)}（{session.running ? "起動中" : "保存済み"}）</option>)}
        {sessionId && !sessions.some(session => session.id === sessionId) && <option value={sessionId}>{snapshot?.threadTargets?.[threadId]?.session.name ?? sessionId}</option>}
      </select></label>
      <p className="text-xs">接続状態: {statusLabel(snapshot?.states[threadId])}</p>
      <button type="button" disabled={!threadId} onClick={() => void save()}>このスレッドを接続</button>
      <label className="block">新しいプロジェクト名<input aria-label="OMPプロジェクト名" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block">作成後の接続<select aria-label="OMP作成後の接続" value={destination} onChange={event => setDestination(event.target.value)}>
        <option value="new-thread">新しいOMBスレッドを作って接続</option><option value="current">このOMBスレッドへ接続</option><option value="none">セッションを保存するだけ</option>
      </select></label>
      <button type="button" disabled={!threadId || !name.trim()} onClick={() => void create()}>名前付きOMPセッションを作成</button>
    </fieldset>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </Card>;
}

import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { NativeDshDestination } from "./NativeDshDestination";
import type { NativeOmpBinding, NativeOmpProject, NativeOmpSessionInfo, NativeOmpThreadTarget } from "../../shared/native-omp";

type Bot = { id: string; name: string; threadId: string; tasks?: { threadId: string; title: string }[] };
type Snapshot = { bindings: NativeOmpBinding[]; threadTargets: Record<string, NativeOmpThreadTarget>; threadModes?: Record<string, "router">; sessionIds: Record<string, string>; states: Record<string, string> };
const statusLabel = (value?: string) => ({ idle: "待機中", "human-working": "標準TUIで実行中", "waiting-on-you": "確認待ち", preparing: "仲介処理中", working: "実行中", disconnected: "未接続", reconnecting: "再接続中", "router-ready": "自由管理（未固定）", failed: "実行失敗（終了済み）" }[value ?? ""] ?? (value?.startsWith("not-sent:") ? "接続前に停止（入力は未送信）" : "未確認"));
export function NativeOmpSettings({ onOpenThread }: { onOpenThread?: (botId: string, threadId: string) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [sessions, setSessions] = useState<NativeOmpSessionInfo[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [kind, setKind] = useState<"manager" | "session" | "router">("session");
  const [projects, setProjects] = useState<NativeOmpProject[]>([]);
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
    setKind(snapshot?.threadModes?.[threadId] === "router" ? "router" : snapshot?.threadTargets?.[threadId]?.kind ?? "session");
  }, [snapshot, threadId]);
  useEffect(() => {
    let live = true; setProjects([]);
    if (botId && threadId) void api<{ projects: NativeOmpProject[] }>(`/api/native-omp/projects?botId=${encodeURIComponent(botId)}&threadId=${encodeURIComponent(threadId)}`).then(result => { if (live) setProjects(result.projects); }).catch(() => { if (live) setMessage("プロジェクト設定を読み込めません。"); });
    return () => { live = false; };
  }, [botId, threadId]);
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
    const result = await api<{ threadId: string; session?: NativeOmpSessionInfo }>("/api/native-omp/threads", { method: "POST", timeoutMs: 130000, body: JSON.stringify({ botId, threadId, kind, ...(kind !== "router" && sessionId ? { sessionId } : {}) }) });
    await reload(); setMessage(kind === "router" ? "自由管理に切り替えました。実行時にセッションを選択・再利用し、必要なら作成します。" : `「${result.session?.name}」に接続しました。`);
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
  return <Card title="NativeConnect / OhMyPi・DeepseekHarness" subtitle="OMBスレッドと接続先の共有セッションを選びます。標準の履歴と入力口を使います。">
    {snapshot && <NativeDshDestination bindings={snapshot.bindings} bots={bots} onSaved={reload} />}
    <p className="text-xs text-ink-secondary">「OMP全体」は、このBotで設定したOMPプロファイル内のセッション一覧・作成・接続を扱う管理接続です。別プロジェクトの会話履歴は混ぜません。チャットからも、名前付きセッションの作成や、新しいOMBスレッドへの接続を依頼できます。</p>
    <fieldset disabled={busy || !snapshot} className="space-y-3">
      <label className="block">Bot<select aria-label="OMP接続のBot" value={botId} onChange={event => { setBotId(event.target.value); setThreadId(bots.find(bot => bot.id === event.target.value)?.threadId ?? ""); setSessions([]); }}>
        <option value="">選択</option>{bots.filter(bot => snapshot?.bindings.some(binding => binding.enabled && binding.botId === bot.id)).map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select></label>
      <label className="block">OMBスレッド<select aria-label="OMP接続のスレッド" value={threadId} onChange={event => setThreadId(event.target.value)}>
        <option value="">選択</option>{bots.find(bot => bot.id === botId)?.tasks?.map(task => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}
      </select></label>
      <button type="button" disabled={!threadId} onClick={() => void work(loadSessions)}>OMPセッション一覧を読み込む</button>
      <label className="block">接続方式<select aria-label="OMP接続方式" value={kind} onChange={event => setKind(event.target.value as "session" | "manager" | "router")}>
        <option value="session">一つのOMPセッションに固定（スレッドと1対1）</option><option value="router">自由管理（セッションを選択・必要に応じて作成）</option><option value="manager">OMP全体（セッション管理）</option>
      </select></label>
      <label className="block">{kind === "manager" ? "管理会話として使うセッション" : "接続するOMPセッション"}<select aria-label="OMPセッション" disabled={kind === "router"} value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">現在の会話を使う</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.name} — {session.id.slice(0, 8)}（{session.running ? "起動中" : "保存済み"}）</option>)}
        {sessionId && !sessions.some(session => session.id === sessionId) && <option value={sessionId}>{snapshot?.threadTargets?.[threadId]?.session.name ?? sessionId}</option>}
      </select></label>
      {kind === "router" && <div className="space-y-3">
        <p className="text-xs">依頼内容と直前の会話から担当を選びます。複合依頼は最大4段階を順に実行し、結果を引き継ぎます。既存セッションを優先し、自動作成は8件まで。表側のスレッドは増やしません。</p>
        <p>プロジェクトと既存セッションの対応</p>
        {projects.map((project, index) => <div key={index} className="space-y-2">
          <label>プロジェクト名<input aria-label={`振り分けプロジェクト名 ${index + 1}`} maxLength={120} value={project.name} onChange={event => setProjects(values => values.map((value, i) => i === index ? { ...value, name: event.target.value } : value))} /></label>
          <label>担当内容・呼び方<input aria-label={`振り分けの説明 ${index + 1}`} maxLength={1500} value={project.description} onChange={event => setProjects(values => values.map((value, i) => i === index ? { ...value, description: event.target.value } : value))} /></label>
          <label>既存セッション<select aria-label={`振り分けセッション ${index + 1}`} value={project.sessionId} onChange={event => setProjects(values => values.map((value, i) => i === index ? { ...value, sessionId: event.target.value } : value))}>
            <option value="">選択</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.name} — {session.id.slice(0, 8)}</option>)}
            {project.sessionId && !sessions.some(session => session.id === project.sessionId) && <option value={project.sessionId}>{project.name} — {project.sessionId.slice(0, 8)}</option>}
          </select></label>
          <button type="button" onClick={() => setProjects(values => values.filter((_, i) => i !== index))}>振り分けから外す {project.name}</button>
        </div>)}
        <button type="button" disabled={projects.length >= 32} onClick={() => setProjects(values => [...values, { name: "", description: "", sessionId: "" }])}>振り分けプロジェクトを追加</button>
        <button type="button" onClick={() => void work(async () => {
          const result = await api<{ projects: NativeOmpProject[] }>("/api/native-omp/projects", { method: "PUT", timeoutMs: 130000, body: JSON.stringify({ botId, threadId, projects }) });
          setProjects(result.projects); setMessage("プロジェクトの振り分け設定を保存しました。次の依頼から反映されます。");
        })}>プロジェクトの振り分けを保存</button>
      </div>}
      <p className="text-xs">接続状態: {statusLabel(snapshot?.states[threadId])}</p>
      <button type="button" disabled={!threadId} onClick={() => void save()}>このスレッドを接続</button>
      {onOpenThread && <button type="button" disabled={!threadId} onClick={() => onOpenThread(botId, threadId)}>選択したスレッドを開く</button>}
      <label className="block">新しいプロジェクト名<input aria-label="OMPプロジェクト名" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block">作成後の接続<select aria-label="OMP作成後の接続" value={destination} onChange={event => setDestination(event.target.value)}>
        <option value="new-thread">新しいOMBスレッドを作って接続</option><option value="current">このOMBスレッドへ接続</option><option value="none">セッションを保存するだけ</option>
      </select></label>
      <button type="button" disabled={!threadId || !name.trim()} onClick={() => void create()}>名前付きOMPセッションを作成</button>
    </fieldset>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </Card>;
}

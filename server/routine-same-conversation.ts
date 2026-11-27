// Automations that keep one conversation (sameConversation: webhooks, app events and schedules): each run continues the
// conversation its trigger's run before worked in. Runs of such a trigger take turns in it (sameRoutineWorking in routines.ts).
import type { RoutineRun } from "./routines.ts";

/** The conversation the same trigger's latest earlier run for this bot worked in; null for its first run. `runs` newest first (listRuns). */
export function previousEventThread(runs: readonly RoutineRun[], run: Pick<RoutineRun, "id" | "routineId" | "botId">): string | null {
  if (!run.routineId) return null;
  return runs.find((other) => other.id !== run.id && other.routineId === run.routineId && other.botId === run.botId && other.threadId)?.threadId ?? null;
}

/** The conversation a run that keeps one conversation joins. Gone (deleted) or never there: null, so this run starts a
 *  new conversation and the next run continues that one. */
export function continuedConversation(runs: readonly RoutineRun[], run: RoutineRun, exists: (threadId: string) => boolean): string | null {
  const previous = run.target === "bot" ? previousEventThread(runs, run) : null;
  return previous && exists(previous) ? previous : null;
}

/** The chat a run pinned to one conversation works in. Gone: `false`, so the caller refuses the run instead of letting a
 *  new conversation be created for it. */
export function pinnedConversation(run: RoutineRun, exists: (threadId: string) => boolean): string | false | null {
  if (run.target !== "bot" || !run.conversationThreadId) return null;
  return exists(run.conversationThreadId) ? run.conversationThreadId : false;
}

/** The thread decision a starting run's own record and join-answer give: the chat it already has, the one it is pinned
 *  to, one it keeps or inherits (`null` creates a chat), or `false` to refuse it rather than create anything. */
export type RunThreadDecision = { kind: "join"; threadId: string } | { kind: "refuse" } | { kind: "create" };

export function runThreadDecision(run: RoutineRun, joined: string | null | false | undefined): RunThreadDecision {
  const threadId = run.threadId || joined || null;
  if (threadId) return { kind: "join", threadId };
  return joined === false ? { kind: "refuse" } : { kind: "create" };
}

/** Every way an outside event's run picks the conversation it works in: the chat the automation pinned it to (gone:
 *  `false`, refused before anything is created), the wait's own chat, the conversation its trigger kept, or, for a
 *  limit-reset routine, its source chat. Null lets the caller create one. */
export function joinedEventConversation(run: RoutineRun, deps: {
  exists: (botId: string, threadId: string) => boolean;
  waitChat: (run: RoutineRun) => string | null | false;
  previousThread: (run: RoutineRun) => string | null;
  limitReset: (run: RoutineRun) => boolean;
  sourceOwner: (run: RoutineRun) => { group?: unknown; bot: { id: string }; threadId: string } | null;
}): string | null | false {
  const pinned = pinnedConversation(run, (threadId) => deps.exists(run.botId, threadId));
  if (pinned !== null) return pinned;
  if (run.eventSource === "wait") return deps.waitChat(run);
  if (run.sameConversation) return deps.previousThread(run);
  if (!deps.limitReset(run) || run.target !== "bot") return null;
  const source = deps.sourceOwner(run);
  return source && !source.group && source.bot.id === run.botId ? source.threadId : null;
}

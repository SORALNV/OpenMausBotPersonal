import { isBackgroundThread, type BackgroundThread } from "../shared/background-thread.ts";
interface MainThreadCandidate extends BackgroundThread {
  threadId: string;
  createdAt: number;
  askedAt?: number;
  archivedAt?: number;
  routineRunId?: string;
}

export function oldestThread(tasks: readonly MainThreadCandidate[]): string | undefined {
  const visible = tasks.filter((task) => !isBackgroundThread(task));
  const open = visible.filter((task) => task.archivedAt === undefined);
  return (open.length ? open : visible).reduce<MainThreadCandidate | undefined>(
    (oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined,
  )?.threadId;
}

export function wasOldestThread(tasks: readonly MainThreadCandidate[], threadId: string): boolean {
  const saved = tasks.find((task) => task.threadId === threadId && !isBackgroundThread(task));
  return saved !== undefined && !tasks.some((task) => !isBackgroundThread(task) && task.archivedAt === undefined && task.createdAt < saved.createdAt);
}

export function mainThread(tasks: readonly MainThreadCandidate[], selectedId?: string): string | undefined {
  const open = tasks.filter((task) => !isBackgroundThread(task) && task.archivedAt === undefined);
  const asked = open.reduce<MainThreadCandidate | undefined>(
    (latest, task) => ((task.askedAt ?? -1) > (latest?.askedAt ?? -1) ? task : latest), undefined,
  );
  return asked?.threadId ?? open.find((task) => task.threadId === selectedId)?.threadId ?? oldestThread(tasks);
}

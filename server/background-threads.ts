import { isBackgroundThread } from "../shared/background-thread.ts";

const backgroundThreads = new Set<string>();

export function trackBackgroundThread(task: { threadId: string; background?: boolean; routineRunId?: string; openedBy?: { kind?: string } }): void {
  if (isBackgroundThread(task)) backgroundThreads.add(task.threadId);
  else backgroundThreads.delete(task.threadId);
}

export const backgroundThread = (threadId: string): boolean => backgroundThreads.has(threadId);

export function backgroundAtCapacity(
  tasks: readonly { threadId: string; background?: boolean; routineRunId?: string; openedBy?: { kind?: string } }[],
  busy: (threadId: string) => boolean,
  targetThreadId?: string,
): boolean {
  if (targetThreadId && !tasks.some(task => task.threadId === targetThreadId && isBackgroundThread(task))) return false;
  return tasks.some(task => task.threadId !== targetThreadId && isBackgroundThread(task) && busy(task.threadId));
}

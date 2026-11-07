export interface BackgroundThread {
  threadId?: string;
  background?: boolean;
  routineRunId?: string;
  openedBy?: { kind?: string };
}

export function isBackgroundThread(task: BackgroundThread): boolean {
  return task.background ?? Boolean(task.routineRunId || task.openedBy?.kind === "work");
}

import { isBackgroundThread, type BackgroundThread } from "../../shared/background-thread";

export interface ThreadVisibilityOwner {
  tasks?: ReadonlyArray<BackgroundThread & { archivedAt?: number }>;
}

export function botThreadsShown(bot: ThreadVisibilityOwner | undefined, configured: boolean): boolean {
  return configured || (import.meta.env.VITE_OMB_PERSONAL === "1" &&
    (bot?.tasks?.filter(task => !isBackgroundThread(task) && task.archivedAt === undefined).length ?? 0) > 1);
}

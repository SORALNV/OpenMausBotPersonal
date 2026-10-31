import { isBackgroundThread, type BackgroundThread } from "../../shared/background-thread";
export function botShowsUnread(bot: {
  unread?: boolean;
  tasks?: ReadonlyArray<{ unread?: boolean; archivedAt?: number } & BackgroundThread> | null;
}): boolean {
  if (!bot.tasks?.length) return Boolean(bot.unread);
  return bot.tasks.some((task) => Boolean(task.unread) && !isBackgroundThread(task) && task.archivedAt === undefined);
}

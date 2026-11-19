import type { Bot, Group } from "@/state/store";

const drawn = (bot: Bot) => [
  // title and chiefOfStaff: the @-mention menu describes each bot by them.
  bot.id, bot.name, bot.title, bot.chiefOfStaff, bot.hidden, bot.sidebarHidden, JSON.stringify(bot.defaultBot ?? null), bot.color, bot.mascotBody, bot.mascotExpression,
  bot.mascotFaceColor, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY,
].join("\u0001");

/** For a reader that draws other bots only by name, look and whether they are shown: a turn changing none of that
 * keeps the earlier list, so the reader does not render again. */
export function sameDrawnBots(a: readonly Bot[], b: readonly Bot[]): boolean {
  return a.length === b.length && a.every((bot, i) => bot === b[i] || drawn(bot) === drawn(b[i]!));
}

const drawnRoom = (group: Group) => [
  group.id, group.name, group.threadId, group.busyBotId, group.unread, group.working,
  ...(group.tasks ?? []).map((task) => `${task.threadId}\u0001${task.busyBotId ?? ""}\u0001${task.working ? 1 : 0}\u0001${task.unread ? 1 : 0}`),
].join("\u0001");

/** The rooms a composer draws while it waits on one of them: which of its threads a bot is busy on, and the room's
 * name. A turn changing none of that keeps the earlier list. */
export function sameDrawnRooms(a: readonly Group[], b: readonly Group[]): boolean {
  return a.length === b.length && a.every((group, i) => group === b[i] || drawnRoom(group) === drawnRoom(b[i]!));
}

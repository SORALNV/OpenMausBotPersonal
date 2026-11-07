import type { BotActivity } from "../shared/wire.ts";

/** A room's aggregate input-wait badge must have an outstanding question in that room. */
export function visibleBotWait(activity: BotActivity | undefined, taskActivities: readonly (BotActivity | undefined)[], rooms: readonly { working: boolean; pendingInput: boolean }[]): BotActivity | undefined {
  if (activity !== "waiting-on-you" || taskActivities.includes("waiting-on-you") || rooms.some(room => room.pendingInput)) return activity;
  return taskActivities.some(value => value === "working" || value === "no-signal") || rooms.some(room => room.working) ? "working" : "idle";
}

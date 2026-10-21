import type { GroupRecord } from "./store.ts";

export function pruneRoomMembership(group: GroupRecord, permissionsSupplied: boolean): void {
  pruneRoomHolds(group);
  if (group.permissions) {
    group.permissions.members = Object.fromEntries(Object.entries(group.permissions.members).filter(([id]) => group.memberIds.includes(id)));
    if (!permissionsSupplied) group.permissionsVersion = (group.permissionsVersion ?? 0) + 1;
  }
}

export function pruneRoomHolds(group: Pick<GroupRecord, "memberIds" | "holds" | "heldMessages">): void {
  for (const key of ["holds", "heldMessages"] as const) {
    const map = group[key];
    if (!map) continue;
    const kept = Object.fromEntries(Object.entries(map).filter(([botId]) => group.memberIds.includes(botId)));
    if (Object.keys(kept).length !== Object.keys(map).length) (group as Record<typeof key, unknown>)[key] = kept;
  }
}


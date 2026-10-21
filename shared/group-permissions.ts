export type GroupResponseMode = "inherit" | "mentions" | "always" | "off";

/** Owner-defined room permissions do not grant access to private chats or host tools. */
export interface GroupMemberPermissions {
  response: GroupResponseMode;
  post: boolean;
  mention: boolean;
  coordinate: boolean;
}

/** A cross-section grant applies only between members in this room. */
export interface GroupPermissions {
  crossSection: boolean;
  members: Record<string, GroupMemberPermissions>;
}

type Room = { memberIds: string[]; permissions?: GroupPermissions };
export const DEFAULT_GROUP_MEMBER_PERMISSIONS: GroupMemberPermissions = {
  response: "inherit", post: true, mention: true, coordinate: true,
};
export function groupMemberPermissions(room: Pick<Room, "permissions">, id: string): GroupMemberPermissions {
  return room.permissions?.members[id] ?? DEFAULT_GROUP_MEMBER_PERMISSIONS;
}
export function groupCanSpeak(room: Room, id: string): boolean {
  return room.memberIds.includes(id) && groupMemberPermissions(room, id).response !== "off";
}
export function groupCrossSection(room: Pick<Room, "permissions">): boolean {
  return room.permissions?.crossSection === true;
}
export function parseGroupPermissions(value: unknown, memberIds: string[]): GroupPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("permissions must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["crossSection", "members"].includes(key)) || typeof raw.crossSection !== "boolean" ||
      !raw.members || typeof raw.members !== "object" || Array.isArray(raw.members)) throw Error("invalid group permissions");
  const entries = Object.entries(raw.members).map(([id, input]) => {
    if (!memberIds.includes(id) || !input || typeof input !== "object" || Array.isArray(input)) throw Error("permission member must belong to this group");
    const row = input as Record<string, unknown>;
    if (Object.keys(row).some(key => !["response", "post", "mention", "coordinate"].includes(key)) ||
        !["inherit", "mentions", "always", "off"].includes(String(row.response)) ||
        [row.post, row.mention, row.coordinate].some(v => typeof v !== "boolean")) throw Error("invalid member permissions");
    return [id, { response: row.response, post: row.post, mention: row.mention, coordinate: row.coordinate } as GroupMemberPermissions] as const;
  });
  return { crossSection: raw.crossSection, members: Object.fromEntries(entries) };
}
export function permittedGroupResponders<T extends { id: string }>(room: Room, available: T[], defaults: T[], mentioned: T[]): T[] {
  return available.filter(member => {
    if (!groupCanSpeak(room, member.id)) return false;
    const mode = groupMemberPermissions(room, member.id).response;
    return mode === "always" || (mode === "mentions" ? mentioned : defaults).some(p => p.id === member.id);
  });
}

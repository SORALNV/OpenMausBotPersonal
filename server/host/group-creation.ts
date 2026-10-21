import type { GroupDefaultResponder, GroupRecord, Store } from "../store.ts";
import { sameAudience } from "../bot-visibility.ts";
import { checkedGroupResponder } from "../routes/groups.ts";
import { parseGroupPermissions } from "../../shared/group-permissions.ts";

export function createGroupCreation({ store, autoRoutingReady }: { store: Pick<Store, "bot" | "createGroup" | "patchGroup">; autoRoutingReady: () => boolean }) {

  function checkedMemberIds(value: unknown): { ok: true; memberIds: string[] } | { ok: false; error: string } {
    if (!Array.isArray(value)) return { ok: false, error: "memberIds must be a list of bot IDs" };
    const invalidIndex = value.findIndex(
      (id) => typeof id !== "string" || !id.trim() || !store.bot(id),
    );
    if (invalidIndex !== -1) {
      return { ok: false, error: `unknown channel member: ${String(value[invalidIndex])}` };
    }
    const memberIds = [...new Set(value as string[])];
    if (!memberIds.length) return { ok: false, error: "a channel needs at least one bot" };
    if (memberIds.every((id) => store.bot(id)?.hidden)) {
      return {
        ok: false,
        error: "a channel needs at least one active bot — every member given is archived",
      };
    }
    return { ok: true, memberIds };
  }

  /** A room is one transcript: a restricted bot's words would otherwise feed a teammate everyone can see. */
  function roomAudienceConflict(memberIds: readonly string[], existing: readonly string[] = []): string | null {
    const members = memberIds.flatMap((id) => {
      const bot = store.bot(id);
      return bot ? [bot] : [];
    });
    for (const added of members.filter((bot) => !existing.includes(bot.id))) {
      const other = members.find((bot) => bot.id !== added.id && !sameAudience(bot.visibility, added.visibility));
      if (other) {
        return `Bots in one room must be visible to the same people. ${added.name} and ${other.name} are not: give them the same visibility first, or use separate rooms.`;
      }
    }
    return null;
  }

  // Shared by the public and Chief room tools: authorization stays at each ingress.
  function createChannel(value: unknown): GroupRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error("channel must be a JSON object"), { status: 400 });
    }
    const body = value as Record<string, unknown>;
  
    const roster = checkedMemberIds(body.memberIds);
    if (!roster.ok) throw Object.assign(new Error(roster.error), { status: 400 });
    const { memberIds } = roster;
    const audienceConflict = roomAudienceConflict(memberIds);
    if (audienceConflict) throw Object.assign(new Error(audienceConflict), { status: 400 });
    if (body.name !== undefined && typeof body.name !== "string") {
      throw Object.assign(new Error("channel name must be a string"), { status: 400 });
    }
    const name = body.name?.trim() || `${store.bot(memberIds[0])!.name} & co.`;
    if (name.length > 100) throw Object.assign(new Error("channel name must be at most 100 characters"), { status: 400 });
    let section: string | undefined;
    if (body.section !== undefined && body.section !== null) {
      if (typeof body.section !== "string") throw Object.assign(new Error("context must be a string"), { status: 400 });
      section = body.section.trim() || undefined;
      if (section && section.length > 60) {
        throw Object.assign(new Error("context must be at most 60 characters"), { status: 400 });
      }
    }
    let setup:
      | { bulletin: string; defaultResponder: GroupDefaultResponder; completed: true }
      | undefined;
    if (body.setup !== undefined) {
      if (!body.setup || typeof body.setup !== "object" || Array.isArray(body.setup)) {
        throw Object.assign(new Error("setup must be an object"), { status: 400 });
      }
      const requested = body.setup as { bulletin?: unknown; defaultResponder?: unknown };
      if (typeof requested.bulletin !== "string") {
        throw Object.assign(new Error("setup.bulletin must be a string"), { status: 400 });
      }
      if (requested.bulletin.length > 12_000) {
        throw Object.assign(new Error("setup.bulletin must be at most 12000 characters"), { status: 400 });
      }
      const responder = checkedGroupResponder(requested.defaultResponder, memberIds);
      if (!responder) throw Object.assign(new Error("invalid setup.defaultResponder"), { status: 400 });
      setup = { bulletin: requested.bulletin, defaultResponder: responder, completed: true };
    }
    const permissions = body.permissions === undefined ? undefined : parseGroupPermissions(body.permissions, memberIds);
    const created = store.createGroup(name, memberIds, false, section, setup ?? (autoRoutingReady() ? { defaultResponder: { kind: "auto" } } : undefined));
    return permissions ? store.patchGroup(created.id, { permissions, permissionsVersion: 1 })! : created;
  }

  function calendarAudienceConflict(body: unknown): string | null {
    const botIds = body && typeof body === "object" ? (body as { botIds?: unknown }).botIds : undefined;
    if (!Array.isArray(botIds) || botIds.length < 2 || botIds.some((id) => typeof id !== "string")) return null;
    return roomAudienceConflict(botIds as string[]);
  }

  return { checkedMemberIds, roomAudienceConflict, calendarAudienceConflict, createChannel };
}

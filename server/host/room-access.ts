import { groupCanSpeak, groupCrossSection, groupMemberPermissions } from "../../shared/group-permissions.ts";
import { sameAudience } from "../bot-visibility.ts";
import type { HandoffView, RoomAddress } from "../coordinator.ts";
import { hasTeamAuthority, peerAllowed, reachRefusal, type LookedAfterBy } from "../peer-roster.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface RoomAccessDeps {
  store: Store;
  /** The person a conversation is private to on a Team Cloud; null elsewhere. */
  privateTo?(threadId: string): string | null;
  lookedAfterBy?: LookedAfterBy;
}

/** Security: what is said in a Team Cloud member's private chat never reaches a room. */
export const PRIVATE_CHAT_ROOM_WRITE = "This is a private chat, and nothing said here goes into a room, where others would read it. Hand the work to the bot directly (leave group_id out), or tell the person what you wanted to post so they can post it themselves.";

/** The one copy of "may this bot speak into this room". Every caller — the bot's post_to_room tool, a
 *  webhook's room delivery — maps these problems to its own audience's wording; none adds a rule. */
export type RoomTalksVerdict =
  | { ok: true }
  | { ok: false; problem: "dm" }
  | { ok: false; problem: "not-member" }
  | { ok: false; problem: "outsider"; name: string }
  | { ok: false; problem: "private" }
  | { ok: false; problem: "setup" }
  | { ok: false; problem: "permissions" | "audience" };

const NOT_A_MEMBER = "The addressed agent isn't a member of this room; work sent to it again goes to it directly, in a thread of its own";
const LEFT_THE_ROOM = "The addressed agent is no longer a member of this room, so its room job stopped; work sent to it again goes to it directly, in a thread of its own";

export function createRoomAccess({ store, privateTo = () => null, lookedAfterBy }: RoomAccessDeps) {
  function roomRootProblem(node: Pick<HandoffView, "groupId" | "threadId" | "botId">): string | undefined {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!bot || bot.hidden) return "The addressed agent no longer exists";
    if (!group || !(group.dm ? group.threadId === node.threadId : store.groupTaskByThread(group.id, node.threadId))) return "Destination room task no longer exists";
    if (!group.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    if (!groupCanSpeak(group, bot.id)) return "Speaking is disabled for this room member";
    if (group.memberIds.some(id => { const member = store.bot(id); return member && !sameAudience(bot.visibility, member.visibility); })) return "Room members no longer share the same audience";
    return undefined;
  }
  function roomHandoffProblem(node: Pick<HandoffView, "groupId" | "threadId" | "botId"> & Partial<Pick<HandoffView, "kind">>, parent?: Pick<HandoffView, "groupId" | "threadId" | "botId">): string | undefined {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!bot || bot.hidden) return "The addressed agent no longer exists";
    if (node.groupId && (!group || group.dm || !store.groupTaskByThread(group.id, node.threadId))) return "Destination room task no longer exists";
    if (!node.groupId && !store.taskByThread(bot.id, node.threadId)) return "Destination bot task no longer exists";
    if (group && parent && privateTo(parent.threadId)) return PRIVATE_CHAT_ROOM_WRITE;
    if (group && roomSetupPending(group)) return "Destination room setup is unfinished";
    if (group && !group.memberIds.includes(bot.id)) return NOT_A_MEMBER;
    if (group && !groupCanSpeak(group, bot.id)) return "Speaking is disabled for this room member";
    // A room job in a thread of its own still answers to its room: a member who left it stops.
    const laneThread = laneRoomThread(node);
    const laneRoom = laneThread ? store.groupByThread(laneThread) : undefined;
    if (laneRoom && !laneRoom.dm && !laneRoom.memberIds.includes(bot.id)) return LEFT_THE_ROOM;
    // Every reader matters: the sender's grant never gives a specialist another team's transcript.
    const outsideSection = (room: GroupRecord, speaker: BotRecord) => room.memberIds.some(id => {
      const member = store.bot(id);
      return member && !hasTeamAuthority(speaker, member.section) && !hasTeamAuthority(member, speaker.section);
    });
    const destinationRoom = group ?? laneRoom;
    if (destinationRoom && !groupCanSpeak(destinationRoom, bot.id)) return "Speaking is disabled for this room member";
    if (destinationRoom && destinationRoom.memberIds.some(id => { const member = store.bot(id); return member && !sameAudience(bot.visibility, member.visibility); })) return "Room members no longer share the same audience";
    if (group && !groupCrossSection(group) && outsideSection(group, bot)) return "Destination room includes a member outside the agent's section";
    if (parent) {
      const from = store.bot(parent.botId);
      const source = parent.groupId ? store.group(parent.groupId) : undefined;
      if (!from || from.hidden || (parent.groupId ? !source || !source.memberIds.includes(from.id) || !store.groupTaskByThread(source.id, parent.threadId) : !store.taskByThread(from.id, parent.threadId))) return "Source membership or task was removed";
      if (source && (!groupCanSpeak(source, from.id) || !groupMemberPermissions(source, from.id).coordinate)) return "Coordination is disabled for this room member";
      if (destinationRoom?.memberIds.includes(from.id) && !groupMemberPermissions(destinationRoom, from.id).coordinate) return "Coordination is disabled for this room member";
      const sharedGrant = destinationRoom && groupCrossSection(destinationRoom) && destinationRoom.memberIds.includes(from.id) && (!source || source.id === destinationRoom.id);
      // Supervision alone never grants a direct chat or another room's access.
      const sharedSupervisor = source && group && source.id === group.id && parent.threadId === node.threadId && hasTeamAuthority(bot, from.section);
      if ((!hasTeamAuthority(from, bot.section) && !sharedSupervisor && !sharedGrant) || (source && !groupCrossSection(source) && outsideSection(source, from))) return "Room work cannot cross the sender's section boundary";
      if (source && group && source.id === group.id && parent.threadId !== node.threadId) return "Same-room work must stay in the originating conversation";
      if (!peerAllowed(from, bot)) return reachRefusal(from, bot, lookedAfterBy)!;
    }
  }

  /** Security: work addressed into a room for a bot outside it goes to that bot directly, in a thread of its own, so
   *  the room's readers never change. A private chat and an unfinished room keep their refusals. */
  function roomHandoffTarget(node: RoomAddress, parent?: Pick<HandoffView, "threadId">): RoomAddress {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!group || group.dm || !bot || bot.hidden || group.memberIds.includes(bot.id)) return node;
    if ((parent && privateTo(parent.threadId)) || roomSetupPending(group)) return node;
    return { botId: bot.id, threadId: bot.threadId };
  }

  function laneRoomThread(n: Pick<HandoffView, "botId" | "threadId" | "groupId">): string | undefined {
    if (n.groupId) return undefined;
    const opener = store.taskByThread(n.botId, n.threadId)?.openedBy;
    return opener?.kind === "work" && opener.roomLane && opener.threadId && store.groupByThread(opener.threadId) ? opener.threadId : undefined;
  }

  /** `fromThreadId`: the conversation a bot speaks from; a webhook speaks from none. */
  function roomTalks(bot: BotRecord, group: GroupRecord, fromThreadId?: string): RoomTalksVerdict {
    if (group.dm) return { ok: false, problem: "dm" };
    if (!group.memberIds.includes(bot.id)) return { ok: false, problem: "not-member" };
    if (fromThreadId !== undefined && privateTo(fromThreadId)) return { ok: false, problem: "private" };
    if (!groupCanSpeak(group, bot.id) || !groupMemberPermissions(group, bot.id).post) return { ok: false, problem: "permissions" };
    if (group.memberIds.some(id => { const member = store.bot(id); return member && !sameAudience(bot.visibility, member.visibility); })) return { ok: false, problem: "audience" };
    const outsider = groupCrossSection(group) ? undefined : group.memberIds
      .map((id) => store.bot(id))
      .find((member) => member && !hasTeamAuthority(bot, member.section) && !hasTeamAuthority(member, bot.section));
    if (outsider) return { ok: false, problem: "outsider", name: outsider.name };
    if (roomSetupPending(group)) return { ok: false, problem: "setup" };
    return { ok: true };
  }

  function roomSetupPending(group: GroupRecord): boolean {
    const hasMarker =
      Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
      Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
    return (
      !group.dm &&
      hasMarker &&
      group.setupCompletedAt == null &&
      group.setupSkippedAt == null &&
      store.messagesFor(group.threadId).length === 0
    );
  }

  /** Read fresh every time; a line stamped via the HTTP API does not count, so a bot cannot re-arm the ceiling it just spent. */
  function lastHumanRoomMessageAt(group: GroupRecord): number | undefined {
    const messages = store.messagesFor(group.threadId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === "user" && message.kind === "text" && !message.via) return message.at;
    }
    return undefined;
  }

  /** Room membership and owner-defined grants are rechecked before every post. */
  function roomPostEligibility(
    bot: BotRecord,
    group: GroupRecord,
    fromThreadId?: string,
  ): { ok: true } | { ok: false; status: number; error: string } {
    const verdict = roomTalks(bot, group, fromThreadId);
    if (verdict.ok) return verdict;
    if (verdict.problem === "dm") {
      return { ok: false, status: 400, error: "that is a one-to-one bot channel, not a room — use coordinate_bots to reach a single bot" };
    }
    if (verdict.problem === "private") return { ok: false, status: 403, error: PRIVATE_CHAT_ROOM_WRITE };
    if (verdict.problem === "permissions") return { ok: false, status: 403, error: "posting is disabled for you in this group" };
    if (verdict.problem === "audience") return { ok: false, status: 403, error: "room members no longer share the same audience" };
    if (verdict.problem === "not-member") return { ok: false, status: 403, error: "you are not a member of that room" };
    if (verdict.problem === "outsider") {
      return { ok: false, status: 403, error: `that room includes @${verdict.name}, who is outside your section — tell the user what you wanted to post there instead` };
    }
    // A bot must never settle whether a room's unfinished setup still counts as pending.
    return { ok: false, status: 409, error: "that room is still being set up — it cannot receive messages yet" };
  }

  return { roomRootProblem, roomHandoffProblem, roomHandoffTarget, roomSetupPending, roomTalks, laneRoomThread, roomPostEligibility, lastHumanRoomMessageAt };
}

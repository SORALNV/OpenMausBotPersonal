import { groupCanSpeak, groupCrossSection, groupMemberPermissions } from "../../shared/group-permissions.ts";
import { sameAudience } from "../bot-visibility.ts";
import type { HandoffView } from "../coordinator.ts";
import { canAccessTeam, coordinatorSupervises, peerAllowed } from "../peer-roster.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface RoomAccessDeps {
  store: Store;
}

export function createRoomAccess({ store }: RoomAccessDeps) {
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
    if (group && !group.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    if (group && !groupCanSpeak(group, bot.id)) return "Speaking is disabled for this room member";
    // A room job in a thread of its own still answers to its room: a member who left it stops.
    const laneThread = laneRoomThread(node);
    const laneRoom = laneThread ? store.groupByThread(laneThread) : undefined;
    if (laneRoom && !laneRoom.dm && !laneRoom.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    // Every reader matters: the sender's grant never gives a specialist another team's transcript.
    const outsideSection = (room: GroupRecord, speaker: BotRecord) => room.memberIds.some(id => {
      const member = store.bot(id);
      return member && !canAccessTeam(speaker, member.section) && !coordinatorSupervises(member, speaker);
    });
    const destinationRoom = group ?? laneRoom;
    if (destinationRoom && !groupCanSpeak(destinationRoom, bot.id)) return "Speaking is disabled for this room member";
    if (destinationRoom && destinationRoom.memberIds.some(id => { const member = store.bot(id); return member && !sameAudience(bot.visibility, member.visibility); })) return "Room members no longer share the same audience";
    if (group && !groupCrossSection(group) && outsideSection(group, bot)) return "Destination room includes a member outside the agent's section";
    if (group && roomSetupPending(group)) return "Destination room setup is unfinished";
    if (parent) {
      const from = store.bot(parent.botId);
      const source = parent.groupId ? store.group(parent.groupId) : undefined;
      if (!from || from.hidden || (parent.groupId ? !source || !source.memberIds.includes(from.id) || !store.groupTaskByThread(source.id, parent.threadId) : !store.taskByThread(from.id, parent.threadId))) return "Source membership or task was removed";
      if (source && (!groupCanSpeak(source, from.id) || !groupMemberPermissions(source, from.id).coordinate)) return "Coordination is disabled for this room member";
      if (destinationRoom?.memberIds.includes(from.id) && !groupMemberPermissions(destinationRoom, from.id).coordinate) return "Coordination is disabled for this room member";
      const sharedGrant = destinationRoom && groupCrossSection(destinationRoom) && destinationRoom.memberIds.includes(from.id) && (!source || source.id === destinationRoom.id);
      // Supervision alone never grants a direct chat or another room's access.
      const sharedSupervisor = source && group && source.id === group.id && parent.threadId === node.threadId && coordinatorSupervises(bot, from);
      if ((!canAccessTeam(from, bot.section) && !sharedSupervisor && !sharedGrant) || (source && !groupCrossSection(source) && outsideSection(source, from))) return "Room work cannot cross the sender's section boundary";
      if (source && group && source.id === group.id && parent.threadId !== node.threadId) return "Same-room work must stay in the originating conversation";
      if (!peerAllowed(from, bot)) return "The recipient is not an allowed peer of the sender";
    }
  }

  function laneRoomThread(n: Pick<HandoffView, "botId" | "threadId" | "groupId">): string | undefined {
    if (n.groupId) return undefined;
    const opener = store.taskByThread(n.botId, n.threadId)?.openedBy;
    return opener?.kind === "work" && opener.roomLane && opener.threadId && store.groupByThread(opener.threadId) ? opener.threadId : undefined;
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

  return { roomRootProblem, roomHandoffProblem, roomSetupPending, laneRoomThread };
}

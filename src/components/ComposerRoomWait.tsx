import type { Dispatch } from "react";
import type { Action, Bot, Group } from "@/state/store";

export function ComposerRoomWait({ profile, group, groups, dispatch }: { profile?: Bot; group?: Group; groups: readonly Group[]; dispatch: Dispatch<Action> }) {
  if (!profile || group) return null;
  const rooms = groups.flatMap(room => (room.tasks ?? [{ threadId: room.threadId, title: room.name, busyBotId: room.busyBotId }])
    .filter(task => (task.busyBotId ?? (task.threadId === room.threadId ? room.busyBotId : null)) === profile.id)
    .map(task => ({ room, task })));
  if (!rooms.length) return null;
  return <div className="mb-2 rounded-2xl border border-hairline bg-raised px-3 py-2 text-[13px]" role="status" data-testid="composer-room-wait">
    {rooms.map(({ room, task }) => <div key={task.threadId}>
      <p>{profile.name}は「{room.name}」で{profile.activity === "waiting-on-you" ? "あなたの返答を待っています" : "作業中です"}。確認が必要なときは、待機先を開いて返答できます。</p>
      <button type="button" className="ui-pill mt-1" onClick={() => dispatch({ type: "switchGroupTask", groupId: room.id, threadId: task.threadId })}>待機先の会話を開く</button>
    </div>)}
  </div>;
}

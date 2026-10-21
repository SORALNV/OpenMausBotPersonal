import { describe, expect, it } from "vitest";

import type { Store } from "../store.ts";
import { createRoomAccess } from "./room-access.ts";

// Only a thread opened as a parallel room job answers to its room; a work
// thread a room conversation opened for anything else does not.
describe("laneRoomThread", () => {
  const tasks: Record<string, { openedBy?: Record<string, unknown> }> = {
    lane: { openedBy: { botId: "lead", name: "Lead", kind: "work", threadId: "room-thread", roomLane: true, at: 1 } },
    work: { openedBy: { botId: "lead", name: "Lead", kind: "work", threadId: "room-thread", at: 1 } },
  };
  const store = {
    taskByThread: (_botId: string, threadId: string) => tasks[threadId],
    groupByThread: (threadId: string) => threadId === "room-thread" ? { id: "room" } : undefined,
  } as unknown as Store;
  const { laneRoomThread } = createRoomAccess({ store });

  it("names the room thread of a parallel room job only", () => {
    expect(laneRoomThread({ botId: "e1", threadId: "lane" })).toBe("room-thread");
    expect(laneRoomThread({ botId: "e1", threadId: "work" })).toBeUndefined();
    expect(laneRoomThread({ botId: "e1", threadId: "lane", groupId: "room" })).toBeUndefined();
  });
});

it("bounds owner cross-section grants to the shared room and rechecks member permissions",()=>{
 const bots:any[]=[{id:"mail",name:"Mail",section:""},{id:"pi",name:"Pi",section:"端末管理部"},{id:"outside",name:"Outside",section:"Other"}];
 const room:any={id:"room",threadId:"room-thread",memberIds:["mail","pi"],permissions:{crossSection:true,members:{}},setupCompletedAt:1};
 const store={bot:(id:string)=>bots.find(b=>b.id===id),group:(id:string)=>id==="room"?room:undefined,groupTaskByThread:(id:string,thread:string)=>id==="room"&&thread==="room-thread"?{}:undefined,taskByThread:()=>({}),groupByThread:()=>undefined,messagesFor:()=>[]} as unknown as Store;
 const access=createRoomAccess({store});const target={groupId:"room",threadId:"room-thread",botId:"pi"};const source={threadId:"mail-thread",botId:"mail"};
 expect(access.roomHandoffProblem(target,source)).toBeUndefined();
 expect(access.roomHandoffProblem({...target,groupId:undefined,threadId:"private-pi"},source)).toContain("section");
 room.permissions.crossSection=false;expect(access.roomHandoffProblem(target,source)).toContain("section");room.permissions.crossSection=true;
 room.permissions.members.mail={response:"inherit",post:true,mention:true,coordinate:false};expect(access.roomHandoffProblem(target,source)).toContain("Coordination");delete room.permissions.members.mail;
 room.permissions.members.pi={response:"off",post:true,mention:true,coordinate:true};expect(access.roomRootProblem(target)).toContain("Speaking");delete room.permissions.members.pi;
 bots[1].visibility="admins";expect(access.roomHandoffProblem(target,source)).toContain("audience");
});

// The conversation routing helpers: which chat a run continues or is pinned to, and why a pinned
// run whose chat is gone must be refused instead of a new chat being created for it.
import { describe, expect, it } from "vitest";

import { continuedConversation, pinnedConversation, previousEventThread } from "./routine-same-conversation.ts";
import type { RoutineRun } from "./routines.ts";

const run = (over: Partial<RoutineRun> = {}): RoutineRun => ({
  id: over.id ?? "run-1", routineId: "hook", routineName: "Watch", target: "bot", botId: "maus-1",
  runOn: "maus", scheduledFor: 0, status: "queued", manual: false, webhookId: "hook", deliveryId: "d1",
  attachments: [], createdAt: 0, ...over,
});

describe("previousEventThread", () => {
  it("returns the latest earlier run's thread for the same trigger and bot", () => {
    const runs = [
      run({ id: "run-2", threadId: "thread-2", status: "completed" }),
      run({ id: "run-1", threadId: "thread-1", status: "completed" }),
    ];
    expect(previousEventThread(runs, run({ id: "run-3" }))).toBe("thread-2");
    expect(previousEventThread(runs, run({ id: "run-2" }))).toBe("thread-1");
    expect(previousEventThread([], run())).toBeNull();
  });
});

describe("continuedConversation", () => {
  it("joins the previous conversation while it still exists, else starts a new one", () => {
    const runs = [run({ id: "run-1", threadId: "thread-1", status: "completed" })];
    const exists = (threadId: string) => threadId === "thread-1";
    expect(continuedConversation(runs, run({ id: "run-2" }), exists)).toBe("thread-1");
    expect(continuedConversation(runs, run({ id: "run-2" }), () => false)).toBeNull();
  });
});

describe("pinnedConversation", () => {
  it("joins the pinned chat while it exists", () => {
    const pinned = run({ conversationThreadId: "main" });
    expect(pinnedConversation(pinned, (threadId) => threadId === "main")).toBe("main");
  });

  it("refuses the run when the pinned chat is gone, so no chat is created for it", () => {
    const pinned = run({ conversationThreadId: "main" });
    expect(pinnedConversation(pinned, () => false)).toBe(false);
  });

  it("leaves unpinned runs to the other routing", () => {
    expect(pinnedConversation(run(), () => true)).toBeNull();
    expect(pinnedConversation(run({ conversationThreadId: undefined }), () => false)).toBeNull();
  });

  it("never pins a room goal run", () => {
    const room = run({ target: "room-goal", groupId: "room-1", conversationThreadId: "main" });
    expect(pinnedConversation(room, () => true)).toBeNull();
  });
});

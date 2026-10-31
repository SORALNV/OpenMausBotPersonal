import { describe, expect, it } from "vitest";
import { isBackgroundThread } from "../shared/background-thread.ts";
import { mainThread } from "./main-thread.ts";
import { backgroundAtCapacity, trackBackgroundThread } from "./background-threads.ts";
import { engineIdleMs } from "./drivers/session-idle.ts";

describe("background conversations", () => {
  it("keeps automatic work out of the main conversation without treating history as a running process", () => {
    const main = { threadId: "person", createdAt: 1, askedAt: 2 };
    const tasks = [main, ...Array.from({ length: 50 }, (_, index) => ({
      threadId: `finished-${index}`, createdAt: index + 3, background: true,
    }))];
    expect(tasks.filter(task => !isBackgroundThread(task))).toEqual([main]);
    expect(mainThread(tasks, "finished-49")).toBe("person");
    expect(backgroundAtCapacity(tasks, () => false)).toBe(false);
  });

  it("recognizes legacy work and allows an explicit promotion", () => {
    expect(isBackgroundThread({ routineRunId: "run" })).toBe(true);
    expect(isBackgroundThread({ openedBy: { kind: "work" } })).toBe(true);
    expect(isBackgroundThread({ openedBy: { kind: "work" }, background: false })).toBe(false);
  });

  it("admits only one background execution per bot, including an approval wait, while leaving the main chat usable", () => {
    const tasks = [{ threadId: "main" }, { threadId: "approval", background: true }, { threadId: "next", background: true }];
    const busy = (id: string) => id === "approval";
    expect(backgroundAtCapacity(tasks, busy)).toBe(true);
    expect(backgroundAtCapacity(tasks, busy, "next")).toBe(true);
    expect(backgroundAtCapacity(tasks, busy, "main")).toBe(false);
    expect(backgroundAtCapacity(tasks, busy, "approval")).toBe(false);
    expect(backgroundAtCapacity(tasks, () => false, "next")).toBe(false);
  });

  it("bounds idle background transports on a local Mac independently of Cloud memory settings", () => {
    const policy = { idleMs: 600_000, minimumMs: 10_000 };
    const local = { enabled: false, headroom: () => 1 };
    trackBackgroundThread({ threadId: "background-idle-test", background: true });
    expect(engineIdleMs("background-idle-test", policy, local)).toBe(30_000);
    trackBackgroundThread({ threadId: "background-idle-test", background: false });
    expect(engineIdleMs("background-idle-test", policy, local)).toBe(600_000);
  });
});

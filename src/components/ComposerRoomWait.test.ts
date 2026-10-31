// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { ComposerRoomWait } from "./ComposerRoomWait";
const bot = { id: "pi", name: "RaspberryPi", activity: "waiting-on-you", tasks: [{ threadId: "direct", activity: "idle", busy: false }] } as Bot;
const group = { id: "all", threadId: "room", name: "ALL", busyBotId: "pi", tasks: [{ threadId: "room", title: "ALL", busyBotId: "pi" }] } as Group;
it("opens the actual room holding the bot rather than a nonexistent direct thread", () => {
  const dispatch = vi.fn(), host = document.createElement("div"), root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(ComposerRoomWait, { profile: bot, groups: [group], dispatch })));
    expect(host.textContent).toContain('RaspberryPiは「ALL」であなたの返答を待っています');
    flushSync(() => host.querySelector("button")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "switchGroupTask", groupId: "all", threadId: "room" });
    flushSync(() => root.render(createElement(ComposerRoomWait, { profile: bot, groups: [group], group, dispatch })));
    expect(host.textContent).toBe("");
    flushSync(() => root.render(createElement(ComposerRoomWait, { profile: bot, groups: [{ ...group, busyBotId: null, tasks: [] }], dispatch })));
    expect(host.textContent).toBe("");
  } finally { flushSync(() => root.unmount()); }
});

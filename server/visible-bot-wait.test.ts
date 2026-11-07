import { expect, it } from "vitest";
import { visibleBotWait } from "./visible-bot-wait.ts";
it("does not advertise a reply wait when no direct thread or room has a question", () => {
  expect(visibleBotWait("waiting-on-you", ["idle", "idle"], [{ working: true, pendingInput: false }])).toBe("working");
  expect(visibleBotWait("waiting-on-you", ["idle"], [])).toBe("idle");
});
it("preserves real questions and unrelated states", () => {
  expect(visibleBotWait("waiting-on-you", ["waiting-on-you"], [])).toBe("waiting-on-you");
  expect(visibleBotWait("waiting-on-you", ["idle"], [{ working: true, pendingInput: true }])).toBe("waiting-on-you");
  expect(visibleBotWait("working", ["idle"], [])).toBe("working");
});

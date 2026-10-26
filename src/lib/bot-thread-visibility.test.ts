import { afterEach, expect, it, vi } from "vitest";
import { botThreadsShown } from "./bot-thread-visibility";
import { botOpensTo, openBot } from "@/state/thread-navigation";

afterEach(() => vi.unstubAllEnvs());

it("keeps explicit Personal conversations reachable in simple mode with thread display disabled", () => {
  vi.stubEnv("VITE_OMB_PERSONAL", "1");
  const bot = { id: "pi", threadId: "shelf", mainThreadId: "manager", tasks: [
    { threadId: "manager" }, { threadId: "mcp" }, { threadId: "shelf" },
  ] };
  expect(botThreadsShown(bot, false)).toBe(true);
  expect(botOpensTo(bot, false)).toBe("shelf");
  const actions: unknown[] = [];
  openBot(action => actions.push(action), bot, false);
  expect(actions).toEqual([{ type: "select", id: "pi" }]);
});

it("does not reintroduce automatic or archived threads into a single-conversation bot", () => {
  vi.stubEnv("VITE_OMB_PERSONAL", "1");
  const bot = { id: "mail", threadId: "job", mainThreadId: "main", tasks: [
    { threadId: "main" }, { threadId: "job", background: true },
    { threadId: "routine", routineRunId: "run" }, { threadId: "work", openedBy: { kind: "work" } },
    { threadId: "old", archivedAt: 1 },
  ] };
  expect(botThreadsShown(bot, false)).toBe(false);
  expect(botOpensTo(bot, false)).toBe("main");
  expect(botThreadsShown(undefined, false)).toBe(false);
});

it("retains the configured upstream behavior outside the Personal build", () => {
  vi.stubEnv("VITE_OMB_PERSONAL", "0");
  const bot = { tasks: [{ threadId: "one" }, { threadId: "two" }] };
  expect(botThreadsShown(bot, false)).toBe(false);
  expect(botThreadsShown(bot, true)).toBe(true);
});

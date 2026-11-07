import { expect, it } from "vitest";
import { botOpensTo, openBot } from "./thread-navigation";

it("returns to the main conversation after inspecting background work in either interface mode", () => {
  const bot = { id: "bot", threadId: "job", mainThreadId: "main", tasks: [
    { threadId: "main" }, { threadId: "job", background: true },
  ] };
  for (const shown of [false, true]) {
    expect(botOpensTo(bot, shown)).toBe("main");
    const actions: unknown[] = [];
    openBot(action => actions.push(action), bot, shown);
    expect(actions).toContainEqual({ type: "switchTask", botId: "bot", threadId: "main" });
  }
});

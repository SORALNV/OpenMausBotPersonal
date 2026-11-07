import { expect, it } from "vitest";
import { createWaitLocationNotice, type WaitLocation } from "./wait-location-notice.ts";
import type { Message } from "./store.ts";

it("delivers normal chat and the existing room link on the wire once per blocking request", () => {
  const rows: Partial<Message>[] = [];
  let destination: WaitLocation | undefined = { botId: "pi", name: "RaspberryPi", color: "pink", threadId: "all-task", title: "ALL / Manager", token: "request-one", groupId: "all", waiting: true };
  const notice = createWaitLocationNotice({ locate: () => destination, messagesFor: () => rows as Message[], append: (_thread, row) => rows.push(row) });
  notice("pi", "direct"); notice("pi", "direct");
  expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ kind: "text", text: expect.stringContaining("順番待ちに入れました") });
  expect(rows[1]).toMatchObject({ comm: { groupId: "all", threadId: "all-task" }, tool: { name: "待機先の会話を開く：ALL / Manager" } });
  destination.token = "next-request"; notice("pi", "direct"); expect(rows).toHaveLength(4);
  destination = undefined; notice("pi", "direct"); expect(rows).toHaveLength(4);
});
it("names a direct conversation with the established threadRef and gives a manual fallback", () => {
  const rows: Partial<Message>[] = [];
  const notice = createWaitLocationNotice({ locate: () => ({ botId: "pi", name: "Pi", color: "pink", threadId: "job", title: "MyShelf", token: "run", waiting: false }), messagesFor: () => rows as Message[], append: (_thread, row) => rows.push(row) });
  notice("pi", "chat");
  expect(rows[0]!.text).toContain("Threadsから「MyShelf」"); expect(rows[1]).toMatchObject({ threadRef: { botId: "pi", threadId: "job", title: "MyShelf" } });
});

import { createHash } from "node:crypto";
import type { Message } from "./store.ts";

export type WaitLocation = {
  threadId: string; title: string; name: string; color: string; token: string;
  groupId?: string; botId: string; waiting: boolean;
};
/** Ordinary chat plus established comm/threadRef wire fields, so clients without the Personal composer still receive the destination. */
export function createWaitLocationNotice(deps: {
  locate(botId: string, origin: string): WaitLocation | undefined;
  messagesFor(threadId: string): readonly Message[];
  append(threadId: string, message: Pick<Message, "role" | "kind"> & Partial<Message>): unknown;
}) {
  return (botId: string, origin: string): void => {
    const destination = deps.locate(botId, origin);
    if (!destination) return;
    const key = `wait-location:${createHash("sha256").update(JSON.stringify([botId, origin, destination.threadId, destination.token])).digest("hex")}`;
    if (deps.messagesFor(origin).some(message => message.tool?.itemId === key)) return;
    const title = `「${destination.title}」`;
    deps.append(origin, { role: "bot", kind: "text", text: `追加の指示を順番待ちに入れました。${destination.name}は${title}で${destination.waiting ? "あなたの返答を待っています" : "作業中です"}。下の会話リンクから移動できます。リンクを開けない端末では、Threadsから${title}を選んでください。` });
    deps.append(origin, { role: "bot", kind: "activity", tool: { name: `待機先の会話を開く：${destination.title}`, itemId: key },
      ...(destination.groupId ? { comm: { groupId: destination.groupId, threadId: destination.threadId, withBotId: botId, withName: destination.title, withColor: destination.color } }
        : { threadRef: { botId, threadId: destination.threadId, title: destination.title } }),
    });
  };
}

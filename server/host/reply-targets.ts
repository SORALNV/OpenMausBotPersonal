import type { Store, Message } from "../store.ts";

export function createReplyTargets({ store }: { store: Pick<Store, "messagesFor"> }) {
  function resolveReplyTarget(threadId: string, value: unknown): Message | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw Object.assign(new Error("replyToId must be a message id"), { status: 400 });
    const target = store.messagesFor(threadId).find((message) => message.id === value);
    if (!target || (target.kind !== "text" && target.kind !== "widget") || !target.text?.trim()) {
      throw Object.assign(new Error("the message being replied to is no longer available"), { status: 404 });
    }
    return target;
  }

  return { resolveReplyTarget };
}

import { expect, it, vi } from "vitest";
import { nativeTurn, type NativeClient } from "./direct-codex-client.ts";

const binding = { botId: "bot", threadId: "source", codexThreadId: "native", hostId: "local" };
function fixture(mode = "ok") {
  const listeners = new Set<(method: string, params: any) => void>();
  const emit = (method: string, params: any) => { for (const listener of listeners) listener(method, params); };
  const client: NativeClient = { request: vi.fn(async (method, params: any) => {
    if (method === "thread/resume") { if (mode === "conflict") throw Error("already has an active writer"); return { thread: { id: "native", status: { type: mode === "busy" ? "active" : "idle" } } }; }
    if (method === "turn/start") {
      emit("item/completed", { threadId: "other", turnId: "wrong", item: { id: "wrong", type: "agentMessage", text: "other thread" } });
      emit("item/completed", { threadId: "native", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "元の回答", phase: "final_answer" } });
      emit("turn/completed", { threadId: "native", turn: { id: "turn", status: mode === "failed" ? "failed" : "completed", items: [] } });
      return { turn: { id: "turn" } };
    }
    return params;
  }), onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, onAsk() {}, close: vi.fn(async () => {}) };
  return { client, emit };
}
it("submits native user text without bot instructions or overrides and handles completion before acknowledgement", async () => {
  const { client } = fixture();
  const result = await nativeTurn(client, binding, { requestId: "request", text: "原文\n$()" }, new AbortController().signal, vi.fn());
  expect(client.request).toHaveBeenNthCalledWith(1, "thread/resume", { threadId: "native", excludeTurns: true });
  expect(client.request).toHaveBeenNthCalledWith(2, "turn/start", { threadId: "native", clientUserMessageId: "request", input: [{ type: "text", text: "原文\n$()", text_elements: [] }] });
  expect(result).toEqual({ codexThreadId: "native", turnId: "turn", text: "元の回答" });
});
it.each(["conflict", "busy"])("refuses %s without sending a turn, retrying or creating another thread", async mode => {
  const { client } = fixture(mode);
  await expect(nativeTurn(client, binding, { requestId: "one", text: "text" }, new AbortController().signal, vi.fn())).rejects.toThrow();
  expect(client.request).toHaveBeenCalledOnce();
});
it("does not present a failed native turn as a successful reply", async () => {
  const { client } = fixture("failed");
  await expect(nativeTurn(client, binding, { requestId: "one", text: "text" }, new AbortController().signal, vi.fn())).rejects.toThrow("failed");
});
it("sends nothing when stopped before dispatch", async () => {
  const { client } = fixture(); const controller = new AbortController(); controller.abort();
  await expect(nativeTurn(client, binding, { requestId: "one", text: "text" }, controller.signal, vi.fn())).rejects.toThrow();
  expect(client.request).not.toHaveBeenCalled();
});

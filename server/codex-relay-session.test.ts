import { describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./codex-relay-session.ts";
import type { NativeClient } from "./direct-codex-client.ts";

function fixture(active = false) {
  const request = vi.fn(async (method: string) => {
    if (method === "thread/read") return { thread: { id: "original", status: { type: active ? "active" : "idle" } } };
    if (method === "thread/fork") return { thread: { id: "worker", forkedFromId: "original" } };
    return {};
  });
  return { request, client: { request } as unknown as NativeClient };
}
describe("dedicated native relay session", () => {
  it("copies history without resuming the original or overriding permissions and model", async () => {
    const { client, request } = fixture();
    expect(await createRelaySession(client, "original", "M1 execution")).toEqual({ threadId: "worker", sourceThreadId: "original", name: "M1 execution" });
    expect(request.mock.calls).toEqual([
      ["thread/read", { threadId: "original" }], ["thread/fork", { threadId: "original", excludeTurns: true }],
      ["thread/name/set", { threadId: "worker", name: "M1 execution" }], ["thread/unsubscribe", { threadId: "worker" }],
    ]);
  });
  it("does not fork an active source", async () => {
    const { client, request } = fixture(true);
    await expect(createRelaySession(client, "original", "M1 execution")).rejects.toThrow("idle");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not retry an uncertain fork result", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async method => { if (method === "thread/fork") throw new Error("timeout"); return { thread: { id: "original", status: { type: "idle" } } }; });
    await expect(createRelaySession(client, "original", "M1 execution")).rejects.toThrow("timeout");
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read", "thread/fork"]);
  });
});

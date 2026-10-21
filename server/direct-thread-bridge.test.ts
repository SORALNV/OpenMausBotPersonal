import { describe, expect, it, vi } from "vitest";
import { DirectThreadBridge, type DirectThreadBinding, type DirectThreadTransport, type DirectTurnReply } from "./direct-thread-bridge.ts";

const binding = (threadId: string, codexThreadId = `native-${threadId}`): DirectThreadBinding => ({ botId: "fixture-bot", threadId, codexThreadId, hostId: "local" });
const input = (text = "架空の確認入力") => ({ requestId: "request-one", text });
const selection = { providerId: "codex", modelId: "luna-fixture", timeoutMs: 1000 };
const reply = (codexThreadId: string, text = "元の詳細な回答"): DirectTurnReply => ({ codexThreadId, turnId: `turn-${codexThreadId}`, text });
function transport(): DirectThreadTransport {
  return { submit: vi.fn(async b => reply(b.codexThreadId)) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("direct native thread routing", () => {
  it("pins separate threads of the same bot and forwards exact user text without bot configuration", async () => {
    const native = transport();
    const bridge = new DirectThreadBridge([binding("a"), binding("b")], native);
    const text = "改行\nと記号 $() を含む原文";
    const a = await bridge.send("fixture-bot", "a", input(text));
    const b = await bridge.send("fixture-bot", "b", input("別の入力"));
    expect(a.binding.codexThreadId).toBe("native-a");
    expect(b.binding.codexThreadId).toBe("native-b");
    expect(native.submit).toHaveBeenNthCalledWith(1, binding("a"), input(text));
    expect(native.submit).toHaveBeenNthCalledWith(2, binding("b"), input("別の入力"));
  });

  it("requires a binding for the exact bot and source thread", async () => {
    const native = transport();
    const bridge = new DirectThreadBridge([binding("a")], native);
    await expect(bridge.send("other-bot", "a", input())).rejects.toThrow("No native thread");
    await expect(bridge.send("fixture-bot", "unknown", input())).rejects.toThrow("No native thread");
    expect(native.submit).not.toHaveBeenCalled();
  });

  it("rejects duplicate bindings and missing IDs", () => {
    expect(() => new DirectThreadBridge([binding("a"), binding("a", "other-native")], transport())).toThrow("more than one");
    expect(() => new DirectThreadBridge([{ ...binding("a"), hostId: "" }], transport())).toThrow("explicit");
  });

  it("does not silently change a pinned target when caller configuration is mutated", async () => {
    const configured = binding("a");
    const native = transport();
    const bridge = new DirectThreadBridge([configured], native);
    configured.codexThreadId = "different";
    const result = await bridge.send("fixture-bot", "a", input());
    expect(result.binding.codexThreadId).toBe("native-a");
  });

  it("serializes two sources targeting the same native thread", async () => {
    const held = deferred<DirectTurnReply>();
    const submit = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(reply("shared"));
    const bridge = new DirectThreadBridge([binding("a", "shared"), binding("b", "shared")], { submit });
    const first = bridge.send("fixture-bot", "a", input());
    await Promise.resolve();
    const second = bridge.send("fixture-bot", "b", input());
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);
    held.resolve(reply("shared"));
    await first; await second;
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("does not serialize independent native threads", async () => {
    const held = deferred<DirectTurnReply>();
    const submit = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(reply("native-b"));
    const bridge = new DirectThreadBridge([binding("a"), binding("b")], { submit });
    const first = bridge.send("fixture-bot", "a", input());
    const second = await bridge.send("fixture-bot", "b", input());
    expect(second.binding.codexThreadId).toBe("native-b");
    held.resolve(reply("native-a")); await first;
  });

  it("propagates writer conflicts without retrying or formatting, and permits a later explicit request", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("already has an active writer")).mockResolvedValue(reply("native-a"));
    const format = vi.fn();
    const bridge = new DirectThreadBridge([binding("a")], { submit }, { format });
    await expect(bridge.send("fixture-bot", "a", input(), selection)).rejects.toThrow("active writer");
    expect(submit).toHaveBeenCalledTimes(1); expect(format).not.toHaveBeenCalled();
    await bridge.send("fixture-bot", "a", input());
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("rejects a reply attributed to another session before it can reach the formatter", async () => {
    const format = vi.fn();
    const bridge = new DirectThreadBridge([binding("a")], { submit: vi.fn().mockResolvedValue(reply("wrong")) }, { format });
    await expect(bridge.send("fixture-bot", "a", input(), selection)).rejects.toThrow("different thread");
    expect(format).not.toHaveBeenCalled();
  });
});

describe("independent display formatting", () => {
  it("preserves the raw answer and never submits formatted text back to Codex", async () => {
    const native = transport(), format = vi.fn().mockResolvedValue("短い表示用の回答");
    const result = await new DirectThreadBridge([binding("a")], native, { format }).send("fixture-bot", "a", input(), selection);
    expect(result.rawText).toBe("元の詳細な回答");
    expect(await result.presentation).toEqual({ text: "短い表示用の回答", formatted: true });
    expect(native.submit).toHaveBeenCalledTimes(1);
    expect(format.mock.calls[0][0]).toEqual({ providerId: selection.providerId, modelId: selection.modelId, question: input().text, answer: result.rawText, signal: expect.any(AbortSignal) });
  });

  it("supports changing providers and models without retaining conversation history", async () => {
    const format = vi.fn().mockResolvedValue("短文");
    const bridge = new DirectThreadBridge([binding("a"), binding("b")], transport(), { format });
    await (await bridge.send("fixture-bot", "a", input("質問A"), selection)).presentation;
    await (await bridge.send("fixture-bot", "b", input("質問B"), { ...selection, providerId: "local", modelId: "cheaper-fixture" })).presentation;
    expect(format.mock.calls[1][0]).toEqual({ providerId: "local", modelId: "cheaper-fixture", question: "質問B", answer: "元の詳細な回答", signal: expect.any(AbortSignal) });
  });

  it("keeps slow formatting outside the native turn queue", async () => {
    const held = deferred<string>(), native = transport();
    const bridge = new DirectThreadBridge([binding("a")], native, { format: () => held.promise });
    const first = await bridge.send("fixture-bot", "a", input(), selection);
    await bridge.send("fixture-bot", "a", input("次の入力"));
    expect(native.submit).toHaveBeenCalledTimes(2);
    held.resolve("短文"); expect((await first.presentation).formatted).toBe(true);
  });

  it("times out an unresponsive formatter without losing the original reply", async () => {
    vi.useFakeTimers();
    try {
      const held = deferred<string>(); let signal: AbortSignal | undefined;
      const bridge = new DirectThreadBridge([binding("a")], transport(), { format: async value => { signal = value.signal; return held.promise; } });
      const result = await bridge.send("fixture-bot", "a", input(), selection);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result.presentation).toEqual({ text: result.rawText, formatted: false, failure: "timeout" });
      expect(signal?.aborted).toBe(true);
      held.resolve("遅すぎる結果");
      expect((await result.presentation).text).toBe(result.rawText);
    } finally { vi.useRealTimers(); }
  });

  it.each(["", "   "])("rejects empty formatted output: %j", async text => {
    const result = await new DirectThreadBridge([binding("a")], transport(), { format: async () => text }).send("fixture-bot", "a", input(), selection);
    expect(await result.presentation).toEqual({ text: result.rawText, formatted: false, failure: "invalid" });
  });

  it("retains raw text on formatter failure or missing implementation", async () => {
    const failed = await new DirectThreadBridge([binding("a")], transport(), { format: async () => { throw new Error("offline"); } }).send("fixture-bot", "a", input(), selection);
    expect((await failed.presentation).failure).toBe("failed");
    const missing = await new DirectThreadBridge([binding("a")], transport()).send("fixture-bot", "a", input(), selection);
    expect((await missing.presentation).failure).toBe("unavailable");
  });

  it("rejects an invalid formatter selection before any native turn is sent", async () => {
    const native = transport();
    const bridge = new DirectThreadBridge([binding("a")], native);
    await expect(bridge.send("fixture-bot", "a", input(), { ...selection, timeoutMs: 0 })).rejects.toThrow("Invalid reply formatter");
    expect(native.submit).not.toHaveBeenCalled();
  });
});

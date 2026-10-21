import { expect, it, vi } from "vitest";
import { relayThroughMediator } from "./codex-relay-mediator.ts";
import type { DirectTurnInput } from "./direct-thread-bridge.ts";
import type { DirectThreadBinding } from "../shared/direct-codex.ts";
const binding = { botId: "bot", threadId: "thread", codexThreadId: "fixed-native", hostId: "local" };
const input = { requestId: "request", text: "架空の原文\n改行と記号 <>& を残す" };
const selection = { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 1000 };
it("uses the mediator before forwarding while preserving the original and fixed destination", async () => {
  const generate = vi.fn(async () => "架空の依頼を確認する。"), submit = vi.fn(async (_binding: Readonly<DirectThreadBinding>, _input: Readonly<DirectTurnInput>) => ({ codexThreadId: "fixed-native", turnId: "turn", text: "架空の回答" }));
  await relayThroughMediator(binding, input, selection, generate, submit, new AbortController().signal);
  const payload = JSON.parse(submit.mock.calls[0][1].text.split("\n").slice(1).join("\n"));
  expect(payload.user_request).toBe(input.text); expect(payload.mediator_note).toBe("架空の依頼を確認する。");
  expect(submit.mock.calls[0][0]).toEqual(binding);
  expect(generate.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]);
});
it("keeps the destination and original input fixed while the mediator is running", async () => {
  let complete!: (note: string) => void;
  const mutableBinding = { ...binding }, mutableInput = { ...input };
  const submit = vi.fn(async (_binding: Readonly<DirectThreadBinding>, _input: Readonly<DirectTurnInput>) => ({ codexThreadId: "fixed-native", turnId: "turn", text: "架空の回答" }));
  const pending = relayThroughMediator(mutableBinding, mutableInput, selection, async () => new Promise(resolve => { complete = resolve; }), submit, new AbortController().signal);
  mutableBinding.codexThreadId = "other"; mutableInput.text = "別の依頼"; complete("架空の整理");
  await pending;
  expect(submit.mock.calls[0][0].codexThreadId).toBe("fixed-native");
  expect(JSON.parse(submit.mock.calls[0][1].text.split("\n").slice(1).join("\n")).user_request).toBe(input.text);
});
it("does not forward after failed preparation", async () => {
  const submit = vi.fn();
  await expect(relayThroughMediator(binding, input, selection, async () => { throw Error("fixture failure"); }, submit, new AbortController().signal)).rejects.toThrow("fixture failure");
  expect(submit).not.toHaveBeenCalled();
});
it("times out even if the selected generator ignores cancellation", async () => {
  const submit = vi.fn();
  await expect(relayThroughMediator(binding, input, { ...selection, timeoutMs: 10 }, async () => new Promise(() => {}), submit, new AbortController().signal)).rejects.toThrow("nothing was sent");
  expect(submit).not.toHaveBeenCalled();
});
it("does not retry a submission with an uncertain result", async () => {
  const submit = vi.fn(async () => { throw Error("connection closed"); });
  await expect(relayThroughMediator(binding, input, selection, async () => "架空の整理", submit, new AbortController().signal)).rejects.toThrow("connection closed");
  expect(submit).toHaveBeenCalledTimes(1);
});
it("rejects an accepted request with an empty answer", async () => {
  await expect(relayThroughMediator(binding, input, selection, async () => "架空の整理", async () => ({ codexThreadId: "fixed-native", turnId: "turn", text: "" }), new AbortController().signal)).rejects.toThrow("no matching answer");
});

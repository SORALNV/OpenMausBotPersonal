import { expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ run: vi.fn(async (_input: any) => "短い表示") }));
vi.mock("./drivers/codex-background-text.ts", () => ({ runCodexOneShot: mocked.run }));
import { directReplyFormatter } from "./direct-codex-formatter.ts";
it("uses the selected model independently for every answer without native thread history or tools", async () => {
  const formatter = directReplyFormatter({ get: () => null });
  const signal = new AbortController().signal;
  for (const modelId of ["gpt-6-luna", "cheaper-model"]) await formatter.format({ providerId: "codex-native", modelId, question: "今回の質問", answer: "今回の元回答", signal });
  expect(mocked.run.mock.calls.map(([args]: any[]) => args.model)).toEqual(["gpt-6-luna", "cheaper-model"]);
  expect(mocked.run.mock.calls[1][0]).not.toHaveProperty("threadId");
  expect(mocked.run.mock.calls[1][0].prompt).toContain(JSON.stringify({ question: "今回の質問", answer: "今回の元回答" }));
});
it("can use another configured text provider and rejects an unavailable provider", async () => {
  const generateText = vi.fn(async () => "別の安価な表示");
  const formatter = directReplyFormatter({ get: id => id === "cheap" ? { generateText } as any : null });
  expect(await formatter.format({ providerId: "cheap", modelId: "model-b", question: "Q", answer: "A", signal: new AbortController().signal })).toBe("別の安価な表示");
  expect(generateText).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: "model-b" }));
  await expect(formatter.format({ providerId: "unknown", modelId: "b", question: "Q", answer: "A", signal: new AbortController().signal })).rejects.toThrow();
});

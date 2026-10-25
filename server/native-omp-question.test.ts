import { expect, it, vi } from "vitest";
import { automaticReportDecline, japaneseNativeQuestion, japanesePermissionDetail } from "./native-omp-question.ts";
import type { NativeOmpBinding } from "../shared/native-omp.ts";

const binding = { mediator: { providerId: "fixture", modelId: "small", timeoutMs: 1000 } } as NativeOmpBinding;

it("declines the native developer-report prompt without approving other yes/no questions", () => {
  expect(automaticReportDecline({ id: "1", method: "select", title: "👻 Your agent swears one of its tools is haunted.\nCall in the devs for an exorcism? Tool name + the spooky bit, nothing personal.", options: ["Yes", "No"] })).toEqual({ value: "No" });
  expect(automaticReportDecline({ id: "2", method: "select", title: "Delete the project?", options: ["Yes", "No"] })).toBeUndefined();
  expect(automaticReportDecline({ id: "3", method: "select", title: "Allow tool: write\nPath: xd://report_issue\nContent:\nsynthetic error", options: ["Approve", "Deny"] })).toEqual({ value: "Deny" });
});

it("translates permission labels without changing the command or paths", () => {
  expect(japanesePermissionDetail({ id: "1", method: "select", title: "Allow tool: write\nPath: proc://fixture/kill\nContent:\n", options: ["Approve", "Deny"] }))
    .toBe("ツール「write」の実行許可\n対象: proc://fixture/kill\n内容:\n");
});

it("translates an ordinary question independently and preserves the choice order", async () => {
  const generate = vi.fn(async () => JSON.stringify({ question: "どの作業を続けますか？", options: ["最初の作業", "次の作業"] }));
  const value = await japaneseNativeQuestion(binding, { id: "1", method: "select", title: "Which project?", options: ["First", "Next"] }, generate, new AbortController().signal);
  expect(value).toEqual({ text: "どの作業を続けますか？", labels: ["最初の作業", "次の作業"], translated: true });
  expect(generate).toHaveBeenCalledOnce();
});

it("uses Japanese yes/no labels without inference for a Japanese question", async () => {
  const generate = vi.fn();
  expect(await japaneseNativeQuestion(binding, { id: "1", method: "select", title: "続けますか？", options: ["Yes", "No"] }, generate, new AbortController().signal))
    .toEqual({ text: "続けますか？", labels: ["はい", "いいえ"], translated: true });
  expect(generate).not.toHaveBeenCalled();
});

it("invalid translations and model failures never become permission or a guessed answer", async () => {
  const question = { id: "1", method: "select" as const, title: "Which project?", options: ["First", "Next"] };
  for (const output of ["Approve", '{"question":"確認","options":["許可"]}', '{"question":"確認","options":["同じ","同じ"]}']) {
    const result = await japaneseNativeQuestion(binding, question, vi.fn(async () => output), new AbortController().signal);
    expect(result.translated).toBe(false); expect(result.text).toContain("自動では回答していません");
    expect(result.labels).toEqual(question.options);
  }
});

import { expect, it } from "vitest";
import { teammateWaitMessage } from "./teammate-wait.ts";
it("explains an authentication blocker in Japanese without pretending work is running", () => {
  for (const host of ["chat.google.com", "github.com"]) {
    const text = teammateWaitMessage("Manager", `Waiting on the person: sign in to ${host}`);
    expect(text).toContain(`${host}へのログインが必要`); expect(text).toContain("本人の確認待ちで停止"); expect(text).toContain("停止ボタン"); expect(text).not.toContain("Waiting");
  }
});
it("retains other questions and bounds the displayed detail", () => {
  expect(teammateWaitMessage("担当", "対象アカウントを選択してください")).toContain("対象アカウントを選択してください");
  expect(teammateWaitMessage("担当", "x".repeat(2000)).length).toBeLessThan(700);
});

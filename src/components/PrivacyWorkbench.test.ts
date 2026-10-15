// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyWorkbench } from "./PrivacyWorkbench";

afterEach(() => vi.unstubAllGlobals());
it("keeps originals out of the composer until a masked preview is explicitly accepted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ text: "⟦人物_001⟧さんへ返信してください。" })));
  vi.stubGlobal("fetch", request);
  const apply = vi.fn();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PrivacyWorkbench, { threadId: "thread-a", onApply: apply })));
    await act(async () => host.querySelector("button")!.click());
    const dialog = document.querySelector("dialog")!;
    const input = dialog.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "星野 架空さんへ返信してください。"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(request).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    await act(async () => [...dialog.querySelectorAll("button")].find(b => b.textContent === "仮名化する")!.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("/api/threads/thread-a/privacy/mask");
    expect(apply).not.toHaveBeenCalled();
    expect([...dialog.querySelectorAll("textarea")].at(-1)!.value).toContain("⟦人物_001⟧");
    await act(async () => [...dialog.querySelectorAll("button")].find(b => b.textContent === "確認した文章を入力欄へ")!.click());
    expect(apply).toHaveBeenCalledWith("⟦人物_001⟧さんへ返信してください。");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

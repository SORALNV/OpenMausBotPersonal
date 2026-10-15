// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyText } from "./PrivacyText";

afterEach(() => vi.unstubAllGlobals());

it("restores only on an explicit local click, renders inert text and drops stale display on a thread change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ text: '<img src="https://example.invalid/private"> 星野 架空' })));
  vi.stubGlobal("fetch", request);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PrivacyText, { text: "⟦人物_001⟧", threadId: "a" })));
    expect(request).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")!.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("/api/privacy/display");
    expect(host.textContent).toContain("星野 架空");
    expect(host.querySelector("img, a, iframe, script")).toBeNull();
    await act(async () => root.render(createElement(PrivacyText, { text: "⟦人物_001⟧", threadId: "b" })));
    expect(host.textContent).not.toContain("星野 架空");
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DirectCodexSettings } from "./DirectCodexSettings";
const mocked = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocked.api }));
it("preserves the pinned destination while allowing a cheaper formatter and live on/off configuration", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const settings = { bindings: [{ botId: "b", threadId: "s", codexThreadId: "native-id", hostId: "local", enabled: true, formatter: { providerId: "codex-native", modelId: "gpt-6-luna", timeoutMs: 60000 } }] };
  mocked.api.mockImplementation(async (path: string, init?: RequestInit) => path.includes("/api/bots") ? { bots: [{ id: "b", name: "M1", threadId: "s" }] } : { settings: init ? JSON.parse(init.body as string) : settings, states: {} });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(DirectCodexSettings)));
    expect((host.querySelector('[aria-label="Codex会話ID 1"]') as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      const input = host.querySelector('[aria-label="整形モデル 1"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cheap-model"); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (host.querySelector('[aria-label="固定接続 1"]') as HTMLButtonElement).click());
    await act(async () => (host.querySelector('[aria-label="入力の仲介 1"]') as HTMLButtonElement).click());
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Codex接続を保存")!.click());
    const write = mocked.api.mock.calls.find(([, init]) => init?.method === "PUT")!;
    const binding = JSON.parse(write[1].body).bindings[0];
    expect(binding.codexThreadId).toBe("native-id"); expect(binding.enabled).toBe(false); expect(binding.formatter.modelId).toBe("cheap-model");
    expect(binding.mediator.modelId).toBe("gpt-6-luna");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

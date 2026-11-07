// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectSettings } from "./NativeConnectSettings";
const mocked = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocked.api }));
afterEach(() => { vi.unstubAllGlobals(); mocked.api.mockReset(); });

it("changes the delegation destination without changing any Bot model or sending a chat message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let settings = { enabled: false, model: "sonnet", models: [{ id: "sonnet", name: "Sonnet" }, { id: "gemini", name: "Gemini" }], active: 0 };
  mocked.api.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") settings = { ...settings, ...JSON.parse(String(init.body)) };
    return structuredClone(settings);
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NativeConnectSettings)));
    await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => { const select = host.querySelector("select")!; select.value = "gemini"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Antigravityへの委託設定を保存")!.click());
    expect(settings).toMatchObject({ enabled: true, model: "gemini" });
    expect(mocked.api.mock.calls.map(([path]) => path)).toEqual(["/api/native-connect", "/api/native-connect"]);
    expect(host.textContent).toContain("次のBotのターンから反映");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

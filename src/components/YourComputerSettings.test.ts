// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { YourComputerSettings } from "./YourComputerSettings";

const mocked = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocked.api }));
afterEach(() => mocked.api.mockReset());

it("shows the target and scope before enabling, and disables immediately on revoke", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state = { enabled: false, deviceId: "12345678-1234-4234-8234-123456789abc", deviceName: "test-mac（Mac）", scope: ["画面の表示", "クリック", "キー入力"] };
  mocked.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/your-computer/confirmation") return { confirmationId: "one-use", deviceId: state.deviceId, deviceName: state.deviceName, scope: state.scope, expiresInMs: 120000 };
    if (init?.method === "PUT") state = { ...state, ...JSON.parse(String(init.body)) };
    return structuredClone(state);
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(YourComputerSettings)));
    expect(host.textContent).toContain("オフ");
    await act(async () => (host.querySelector('[aria-label="このPC操作を常時許可する"]') as HTMLButtonElement).click());
    expect(host.textContent).toContain("対象PC：test-mac（Mac）");
    expect(host.textContent).toContain("画面の表示、クリック、キー入力");
    expect(state.enabled).toBe(false);
    expect(mocked.api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "このPCを常時許可")!.click());
    expect(state.enabled).toBe(true);
    expect(JSON.parse(String(mocked.api.mock.calls.find(([, init]) => init?.method === "PUT")?.[1].body))).toMatchObject({ enabled: true, confirmationId: "one-use" });
    expect(host.textContent).toContain("許可中");
    await act(async () => (host.querySelector('[aria-label="このPC操作を常時許可する"]') as HTMLButtonElement).click());
    expect(state.enabled).toBe(false);
    expect(JSON.parse(String(mocked.api.mock.calls.filter(([, init]) => init?.method === "PUT")[1][1].body))).toEqual({ enabled: false });
    expect(host.textContent).toContain("常時許可を解除しました");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

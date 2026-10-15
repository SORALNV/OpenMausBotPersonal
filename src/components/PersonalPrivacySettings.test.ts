// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PERSONAL_PRIVACY } from "../../shared/personal-privacy";
import { PersonalPrivacySettings } from "./PersonalPrivacySettings";

const mocked = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocked.api }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("saves opt-in automation settings and multiple variants, without sending a chat message or storing them in browser storage", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocked.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/routines") return { routines: [{ id: "r-a", name: "架空の定期取得", runOn: "maus", target: "bot" }] };
    if (init?.method === "PUT") return { settings: JSON.parse(init.body as string), state: "loading" };
    return { settings: structuredClone(DEFAULT_PERSONAL_PRIVACY), state: "off" };
  });
  const localWrite = vi.spyOn(Storage.prototype, "setItem");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const click = async (text: string) => act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click(); });
  const fill = async (label: string, text: string) => act(async () => {
    const field = host.querySelector(`[aria-label="${label}"]`)!;
    const proto = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => root.render(createElement(PersonalPrivacySettings)));
    expect(host.textContent).toContain("通常のチャットはそのまま");
    await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
    await click("置換ルールを追加");
    await fill("置換先 1", "ユーザーA"); await fill("置換する表記 1", "星野架空\nほしのかくう\nKaku Hoshino\n");
    await click("置換ルールを追加");
    await fill("置換先 2", "ユーザーB"); await fill("置換する表記 2", "青空虚構\nあおぞらきょこう");
    await click("マスク設定を保存");
    const write = mocked.api.mock.calls.find(([, init]) => init?.method === "PUT")!;
    const settings = JSON.parse(write[1].body);
    expect(settings.enabled).toBe(true);
    expect(settings.aliases).toEqual([{ replacement: "ユーザーA", variants: ["星野架空", "ほしのかくう", "Kaku Hoshino"] }, { replacement: "ユーザーB", variants: ["青空虚構", "あおぞらきょこう"] }]);
    expect(mocked.api.mock.calls.every(([path]) => ["/api/privacy/settings", "/api/routines"].includes(path))).toBe(true);
    expect(host.textContent).toContain("Mac内で読込中"); expect(host.textContent).toContain("次回の対象の定期実行"); expect(localWrite).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); localWrite.mockRestore(); }
});

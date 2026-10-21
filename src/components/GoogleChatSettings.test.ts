// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GoogleChatSettings } from "./GoogleChatSettings";

const mocked = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocked.api }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("connects the selected existing bot and stops through owner API without sending credentials or a user message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocked.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/bots?messages=0") return { bots: [{ id: "bot", name: "予定管理人", threadId: "conversation" }] };
    return { enabled: init?.method === "POST", botId: "bot", state: "OK", cursor: 1 };
  });
  const localWrite = vi.spyOn(Storage.prototype, "setItem");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const click = (text: string) => act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click(); });
  try {
    await act(async () => root.render(createElement(GoogleChatSettings)));
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("bot");
    await click("Google Chatを接続");
    const connect = mocked.api.mock.calls.find(([path]) => path === "/api/google-chat/connect")!;
    expect(connect[1].method).toBe("POST"); expect(JSON.parse(connect[1].body)).toEqual({ botId: "bot", threadId: "conversation" });
    expect(host.textContent).toContain("監視接続: OK");
    expect(host.textContent).toContain("未確認（接続正常だけでは本文取得の成功を意味しません）");
    await click("Google Chatの受信を停止");
    const stop = mocked.api.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(stop[1].body)).toEqual({ enabled: false });
    expect(localWrite).not.toHaveBeenCalled();
    expect(mocked.api.mock.calls.some(([path]) => /messages|send/.test(path) && path !== "/api/bots?messages=0")).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); localWrite.mockRestore(); }
});
it("checks the masked body separately from healthy transport and displays only the returned count", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocked.api.mockImplementation(async (path: string) => {
    if (path === "/api/bots?messages=0") return { bots: [{ id: "bot", name: "予定管理人", threadId: "conversation" }] };
    return { enabled: true, botId: "bot", state: "OK", cursor: 40,
      diagnostics: { body: { stage: "mask", startedAt: "2026-10-18T00:00:00Z", endedAt: "2026-10-18T00:01:00Z", code: path.endsWith("/check") ? "OK" : "MASK_TIMEOUT", elapsedMs: 60000 } },
      ...(path.endsWith("/check") ? { check: { messages: 47 } } : {}),
    };
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(GoogleChatSettings)));
    expect(host.textContent).toContain("監視接続: OK");
    expect(host.textContent).toContain("失敗 / mask / MASK_TIMEOUT");
    await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "本文取得を診断")!.click(); });
    expect(mocked.api).toHaveBeenCalledWith("/api/google-chat/check", { method: "POST", body: "{}", timeoutMs: 140000 });
    expect(host.textContent).toContain("本文取得・ローカルマスク完了: 47件（AIへ未送信）");
    expect(host.textContent).toContain("完了 / mask / OK");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

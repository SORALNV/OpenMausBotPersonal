// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { restoreComposerDraft } from "@/lib/drafts";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: { ...actual.initialState, bots: [bot], instances: [{ instanceId: "fake", capabilities: { queueing: true } }] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
import { Composer } from "./Composer";
const bot: Bot = { id: "delivery-bot", threadId: "delivery-thread", name: "Fixture", title: "", description: "", color: "blue", notifications: false, unread: false, busy: true, messages: [], modelSelection: { instanceId: "fake", model: "fake" } };
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("sends separate intents with Enter and Cmd+Enter, keeps Shift+Enter and IME, and exposes both buttons", () => {
  vi.stubEnv("VITE_OMB_PERSONAL", "1");
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const draftId = `bot:${bot.id}:${bot.threadId}`;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(Composer, { bot })));
    const fill = () => flushSync(() => restoreComposerDraft(draftId, { text: "架空の本文", attachments: [] }));
    const press = (init: KeyboardEventInit) => { const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }); flushSync(() => host.querySelector("textarea")!.dispatchEvent(event)); return event; };
    fill(); expect(host.querySelector('[aria-label="実行中に差し込む"]')).not.toBeNull();
    expect(press({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(host.querySelector("textarea")!.value).toContain("\n");
    fill();
    expect(press({ isComposing: true }).defaultPrevented).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    press({}); expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "send", delivery: "queue", text: "架空の本文" }));
    fill(); press({ metaKey: true }); expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "send", delivery: "steer" }));
    fill(); flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="実行中に差し込む"]')!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: "steer" }));
  } finally { flushSync(() => root.unmount()); host.remove(); restoreComposerDraft(draftId, { text: "", attachments: [] }); }
});

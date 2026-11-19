// @vitest-environment happy-dom
// The Personal fork's Settings additions on the new settings router: the bot permissions page,
// the personal cards General carries, and the legacy links that still name them.
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  section: "overview" as AppSettingsSection,
  advanced: false,
  admin: true as boolean | null,
  config: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  snapshot: {
    appSettingsSection: "overview" as AppSettingsSection, appSettingsPhonePairing: 0, appSettingsCloudLink: 0,
    instances: [] as never[], bots: [] as never[], groups: [] as never[], config: {} as Record<string, unknown>, activeView: "chat" as const,
  },
  api: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  // useStore gives one stable snapshot object: a fresh object each read would loop useSyncExternalStore.
  useStore: () => ({ state: useSyncExternalStore(
    (listener: () => void) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; },
    () => fixture.snapshot,
    () => fixture.snapshot,
  ), dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("../BotPermissionBoard", () => ({ BotPermissionBoard: () => "BOT_PERMISSION_BOARD" }));
vi.mock("../PersonalComposerSettings", () => ({ PersonalComposerSettings: () => "PERSONAL_COMPOSER" }));
vi.mock("../PersonalPrivacySettings", () => ({ PersonalPrivacySettings: () => "PERSONAL_PRIVACY" }));
vi.mock("../YourComputerSettings", () => ({ YourComputerSettings: () => "YOUR_COMPUTER" }));
vi.mock("../NativeConnectSettings", () => ({ NativeConnectSettings: () => "NATIVE_CONNECT" }));
vi.mock("../DirectCodexSettings", () => ({ DirectCodexSettings: () => "DIRECT_CODEX" }));
vi.mock("../BotThreadCleanupSettings", () => ({ BotThreadCleanupSettings: () => "BOT_THREAD_CLEANUP" }));
vi.mock("../NativeOmpSettings", () => ({ NativeOmpSettings: () => "NATIVE_OMP" }));

import { SettingsModal } from "../SettingsModal";
import { LEGACY_SETTINGS, SETTINGS_PAGES, fullContext, resolveSettingsTarget, searchSettings, visiblePages } from "./settings-index";

const desktopHere = (extra: Record<string, unknown> = {}) => ({ ogb: { platform: "darwin", companion: { state: () => new Promise(() => {}) }, environments: { state: () => new Promise(() => {}) }, ...extra } });
let host: HTMLDivElement;
let root: Root;

const render = (section: AppSettingsSection = fixture.snapshot.appSettingsSection) => {
  fixture.snapshot = { ...fixture.snapshot, appSettingsSection: section };
  return renderToStaticMarkup(createElement(SettingsModal));
};
const navPages = (html: string) => [...html.matchAll(/data-settings-page="([a-z]+)"/g)].map((match) => match[1]);
const find = (query: string) => searchSettings(query, fullContext(), (entry) => t(entry.labelKey), (page) => t(page.labelKey));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_OMB_PERSONAL", "1");
  fixture.snapshot = { ...fixture.snapshot, appSettingsSection: "overview", config: {} };
  fixture.advanced = false;
  fixture.admin = true;
  fixture.api.mockImplementation(() => new Promise(() => {}));
  fixture.dispatch.mockReset();
  fixture.dispatch.mockImplementation((action: { type: string; section?: AppSettingsSection }) => {
    if (action.type === "toggleAppSettings" && action.section) {
      fixture.snapshot = { ...fixture.snapshot, appSettingsSection: action.section };
      for (const listener of fixture.listeners) listener();
    }
  });
  vi.stubGlobal("ogb", desktopHere().ogb);
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setLocale("en");
});

describe("the Personal permissions page", () => {
  it("is a page of its own, on the rail beside AI, offered to an owner or admin without a team or cloud requirement", () => {
    expect(SETTINGS_PAGES.find((page) => page.id === "permissions")).toBeDefined();
    expect(LEGACY_SETTINGS).toHaveProperty("botPermissions");
    expect(LEGACY_SETTINGS.botPermissions(fullContext())).toEqual({ page: "permissions" });
    for (const config of [{}, { cloudHome: true }, { team: { id: "fixture-team", name: "Fixture team" } }]) {
      fixture.snapshot = { ...fixture.snapshot, config };
      const html = render("overview");
      expect(navPages(html)).toContain("permissions");
      expect(html).toContain("Bot services &amp; MCP permissions");
    }
  });

  it.each([false, true])("shows for Simple and Advanced admins and renders the board only on its page (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    expect(navPages(render("overview"))).toContain("permissions");
    const board = render("permissions");
    expect(board).toContain("BOT_PERMISSION_BOARD");
    expect(board).not.toContain("PERSONAL_PRIVACY");
    expect(board).not.toContain("NATIVE_OMP");
  });

  it("keeps service permissions distinct from the people sharing page's search words", () => {
    expect(find("access matrix")[0]?.entry.id).toBe("permission-board");
    expect(find("access matrix").map((hit) => hit.entry.id)).not.toContain("bot-access");
  });

  it("hides the page and the board from a team's member, a pending role lookup and paired-client mode", () => {
    fixture.admin = false;
    expect(navPages(render("overview"))).not.toContain("permissions");
    const member = render("botPermissions");
    expect(member).toMatch(/data-settings-page-open="overview"/);
    expect(member).not.toContain("BOT_PERMISSION_BOARD");
    fixture.admin = null;
    expect(navPages(render("overview"))).not.toContain("permissions");
    fixture.admin = true;
    vi.stubGlobal("ogb", desktopHere({ remoteClient: { active: true } }).ogb);
    expect(navPages(render("overview"))).not.toContain("permissions");
    expect(render("botPermissions")).not.toContain("BOT_PERMISSION_BOARD");
  });

  it.each(["en", "ja"] as const)("finds the board from English and Japanese search words (%s)", (locale) => {
    setLocale(locale);
    act(() => { root.render(createElement(SettingsModal)); });
    for (const query of ["permissions", "service", "mcp", "access matrix", "tools", "権限", "サービス"]) {
      const input = document.querySelector<HTMLInputElement>("[data-settings-search]")!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const hit = document.querySelector<HTMLButtonElement>('[data-settings-hit="permission-board"]');
      expect(hit, query).not.toBeNull();
      act(() => hit!.click());
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "permissions" });
      expect(document.querySelector("[data-settings-page-open]")?.getAttribute("data-settings-page-open")).toBe("permissions");
      expect(document.body.textContent).toContain("BOT_PERMISSION_BOARD");
    }
  });

  it("does not turn Advanced on for the page, and lands the legacy botPermissions link there", () => {
    fixture.advanced = false;
    expect(resolveSettingsTarget("botPermissions", fullContext({ advanced: false }))).toEqual({ page: "permissions" });
    expect(render("botPermissions")).toMatch(/data-settings-page-open="permissions"/);
  });
});

describe("General's Personal entries", () => {
  it("replaces the send-key row with the composer binding row and carries every personal card", () => {
    fixture.advanced = true;
    const html = render("general");
    expect(html).toContain("PERSONAL_COMPOSER");
    expect(html).not.toContain("Send messages with");
    for (const marker of ["PERSONAL_PRIVACY", "YOUR_COMPUTER", "NATIVE_CONNECT", "DIRECT_CODEX", "BOT_THREAD_CLEANUP", "NATIVE_OMP"]) {
      expect(render("general")).toContain(marker);
    }
  });

  it("keeps the personal cards off a paired client this window drives, like the fork's general page did", () => {
    fixture.advanced = true;
    vi.stubGlobal("ogb", desktopHere({ remoteClient: { active: true } }).ogb);
    const html = render("general");
    for (const marker of ["PERSONAL_PRIVACY", "YOUR_COMPUTER", "NATIVE_CONNECT", "DIRECT_CODEX", "BOT_THREAD_CLEANUP", "NATIVE_OMP"]) {
      expect(html).not.toContain(marker);
    }
  });
});

it("leaves the router untouched when the Personal build flag is off", () => {
  vi.unstubAllEnvs();
  fixture.advanced = true;
  expect(visiblePages(fullContext()).map((page) => page.id)).not.toContain("permissions");
  expect(navPages(render("overview"))).not.toContain("permissions");
  const general = render("general");
  expect(general).toContain("Send messages with");
  expect(general).not.toContain("PERSONAL_COMPOSER");
  expect(general).not.toContain("PERSONAL_PRIVACY");
});

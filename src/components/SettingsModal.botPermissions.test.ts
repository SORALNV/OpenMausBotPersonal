// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import { SECTIONS, SettingsModal, sectionMatches } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "botPermissions" as AppSettingsSection,
  advanced: false,
  ownerOrAdmin: true as boolean | null,
  config: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; };
  const read = () => fixture.section;
  return {
    ...actual,
    api: vi.fn(),
    useStore: () => ({
      state: { ...actual.initialState, appSettingsSection: useSyncExternalStore(subscribe, read, read), config: fixture.config },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./BotPermissionBoard", () => ({ BotPermissionBoard: () => "BOT_PERMISSION_BOARD" }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => null }));
vi.mock("./PhoneDevicesSection", () => ({ PhoneDevicesSection: () => null }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./SettingsSimplePages", async (original) => ({
  ...await original<typeof import("./SettingsSimplePages")>(),
  SimpleGeneralPage: () => null,
  SimpleComputerPage: () => null,
}));

let host: HTMLDivElement;
let root: Root;
const navAttribute = () => fixture.advanced ? "data-settings-section" : "data-settings-page";
const tab = () => document.querySelector<HTMLButtonElement>(`[${navAttribute()}="botPermissions"]`);
const render = () => renderToStaticMarkup(createElement(SettingsModal));

beforeEach(() => {
  fixture.section = "botPermissions";
  fixture.ownerOrAdmin = true;
  fixture.config = {};
  fixture.dispatch.mockReset();
  fixture.dispatch.mockImplementation((action: { type: string; section?: AppSettingsSection }) => {
    if (action.type === "toggleAppSettings" && action.section) {
      fixture.section = action.section;
      for (const listener of fixture.listeners) listener();
    }
  });
  vi.stubGlobal("ogb", undefined);
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setLocale("en");
});

function search(value: string) {
  flushSync(() => {
    const input = document.querySelector<HTMLInputElement>("[data-settings-search]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe.each([false, true])("Bot permissions navigation (advanced: %s)", (advanced) => {
  beforeEach(() => { fixture.advanced = advanced; });

  it.each([{}, { cloudHome: true }, { team: { id: "fixture-team", name: "Fixture team" } }])("offers admins a first-class tab without a team/cloud requirement: %j", (config) => {
    fixture.config = config;
    const html = render();
    expect(html).toContain(`${navAttribute()}="botPermissions"`);
    expect(html).toContain('value="botPermissions"');
    expect(html).toContain("BOT_PERMISSION_BOARD");
    expect(html).toContain(`${navAttribute()}="botPermissions" aria-current="page"`);
  });

  it("hides the tab from members and guards an advanced deep link", () => {
    fixture.ownerOrAdmin = false;
    const html = render();
    expect(html).not.toContain(`${navAttribute()}="botPermissions"`);
    expect(html).not.toContain('value="botPermissions"');
    expect(html).not.toContain("BOT_PERMISSION_BOARD");
    if (advanced) expect(html).toContain("data-admin-only");
  });

  it("does not expose the tab while role lookup is pending", () => {
    fixture.ownerOrAdmin = null;
    fixture.section = "companion";
    expect(render()).not.toContain(`${navAttribute()}="botPermissions"`);
  });

  it("preserves desktop companion remoteActive restrictions", () => {
    vi.stubGlobal("ogb", { remoteClient: { active: true }, environments: {} });
    const html = render();
    expect(html).not.toContain(`${navAttribute()}="botPermissions"`);
    expect(html).not.toContain('value="botPermissions"');
    expect(html).not.toContain("BOT_PERMISSION_BOARD");
  });

  it.each(["en", "ja"] as const)("finds and navigates to the board from English/Japanese search words (%s)", (locale) => {
    setLocale(locale);
    fixture.section = "companion";
    flushSync(() => root.render(createElement(SettingsModal)));
    for (const query of ["permissions", "service", "MCP", "access matrix", "tools", "権限", "サービス"]) {
      search(query);
      expect(tab(), query).not.toBeNull();
      flushSync(() => tab()!.click());
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "botPermissions" });
      expect(document.body.textContent).toContain("BOT_PERMISSION_BOARD");
    }
    search("no-such-permission-fixture");
    expect(tab()).toBeNull();
  });

  it("never returns a member-only permissions tab in search", () => {
    fixture.ownerOrAdmin = false;
    fixture.section = "companion";
    flushSync(() => root.render(createElement(SettingsModal)));
    search("access matrix");
    expect(tab()).toBeNull();
    expect(document.body.textContent).not.toContain("BOT_PERMISSION_BOARD");
  });
});

it("keeps service permissions distinct from the people-sharing Bot access page", () => {
  const permissions = SECTIONS.find((entry) => entry.id === "botPermissions")!;
  const sharing = SECTIONS.find((entry) => entry.id === "botAccess")!;
  expect(permissions.labelKey).toBe("permissionBoard.title");
  expect(permissions.group).toBe("ai");
  expect(sectionMatches(permissions, "access matrix")).toBe(true);
  expect(sectionMatches(sharing, "access matrix")).toBe(false);
  expect(sharing.labelKey).toBe("settings.section.botAccess");
});

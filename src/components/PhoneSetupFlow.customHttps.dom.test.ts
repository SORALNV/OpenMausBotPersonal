// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { CompanionAccountState } from "../types/ogb";
import { PhoneSetupFlowView, usePhoneSetupController, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";

const CUSTOM = "https://phone.example.test:8443";
let host: HTMLDivElement;
let root: Root;
let controller: PhoneSetupController;

function Probe() {
  controller = usePhoneSetupController();
  return createElement(PhoneSetupFlowView, { controller });
}

function desktop(status: CompanionAccountState["status"], saved: string | null = CUSTOM, advertised = saved) {
  let state: CompanionState = {
    enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null,
    customHostedUrl: saved,
    lan: "192.168.1.42", tailnetName: "stale.tail1234.ts.net",
    e2e: { enabled: true, relay: "off", node: null, descriptor: { v: 1, k: "a".repeat(87) } },
  };
  const account: CompanionAccountState = { available: true, status };
  const bridge = {
    companion: {
      state: vi.fn(async () => state),
      start: vi.fn(async () => {
        state = { ...state, enabled: true, endpoints: advertised ? [{ kind: "hosted", url: advertised, priority: 0 }] : [] };
        return state;
      }),
      pairing: vi.fn(async (open: boolean) => {
        state = { ...state, pairing: open ? { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 } : null };
        return state;
      }),
    },
    companionAccount: {
      state: vi.fn(async () => account),
      prepare: vi.fn(async () => account),
    },
  };
  return { bridge, removeRoute: () => { state = { ...state, endpoints: [] }; } };
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});
async function mount(fake: ReturnType<typeof desktop>) {
  (globalThis as { ogb?: unknown }).ogb = fake.bridge;
  flushSync(() => root.render(createElement(Probe)));
  await vi.waitFor(() => expect(controller.state).not.toBeNull());
  flushSync(() => controller.start());
}

describe("custom HTTPS pairing with an isolated preload fixture", () => {
  for (const status of ["signed-out", "connecting", "error", "ready"] as const) {
    it(`starts the saved HTTPS entrance without managed prepare when account is ${status}`, async () => {
      const fake = desktop(status);
      await mount(fake);
      await vi.waitFor(() => expect(controller.phase).toBe("qr"));
      expect(fake.bridge.companion.start).toHaveBeenCalledOnce();
      expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
      expect(fake.bridge.companionAccount.prepare).not.toHaveBeenCalled();
      expect(controller.addressText).toBe(CUSTOM);
      const params = new URL(controller.pairingLink!).searchParams;
      const endpoints = JSON.parse(atob(params.get("endpoints")!.replaceAll("-", "+").replaceAll("_", "/")));
      expect(endpoints).toEqual([{ kind: "hosted", url: CUSTOM, priority: 0 }]);
      expect(host.textContent).toContain(`HTTPS${CUSTOM}`);
      expect(host.textContent).not.toContain("192.168.1.42");
      expect(host.textContent).not.toContain("stale.tail1234.ts.net");
      expect(params.has("code")).toBe(false);
    });
  }

  for (const saved of ["http://phone.example.test", "https://user:pass@phone.example.test", "https://phone.example.test/path", "broken"]) {
    it(`does not treat invalid saved or advertised HTTPS as usable: ${saved}`, async () => {
      const fake = desktop("connecting", saved);
      await mount(fake);
      await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalled());
      expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
      expect(controller.pairingLink).toBeNull();
    });
  }

  it("does not bypass managed preparation when the saved HTTPS entrance is not advertised", async () => {
    const fake = desktop("connecting", CUSTOM, null);
    await mount(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalled());
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
  });

  it("does not mistake a different advertised HTTPS entrance for the saved custom route", async () => {
    const managed = "https://managed.example.test";
    const fake = desktop("connecting", CUSTOM, managed);
    await mount(fake);
    await vi.waitFor(() => expect(controller.phase).toBe("qr"));
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
    expect(controller.addressText).toBe(managed);
    expect(host.textContent).toContain(`HTTPS${managed}`);
    expect(host.textContent).not.toContain(CUSTOM);
  });

  it("invalidates the pinned QR if its HTTPS entrance disappears instead of falling back to Wi-Fi", async () => {
    const fake = desktop("signed-out");
    await mount(fake);
    await vi.waitFor(() => expect(controller.phase).toBe("qr"));
    fake.removeRoute();
    await vi.waitFor(() => expect(controller.pairingLink).toBeNull(), { timeout: 3_000 });
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(false, `omb_pair_${"a".repeat(43)}`);
    expect(host.textContent).not.toContain(CUSTOM);
  });
});

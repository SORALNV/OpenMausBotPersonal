// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./cloud-buy/CloudMascotScene", () => ({ CloudMascotScene: () => null }));
const { OwnServerLink } = await import("./PlaceAddSheet");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const link = "https://fixture.example/pair#code=7KQ2-M9XD-H4TP";
let host: HTMLDivElement, root: Root;
let settle: (value: unknown) => void;
const add = vi.fn();
const connected = vi.fn();
const probe = vi.fn(async () => ({ outcome: "found", origin: "https://fixture.example", label: "Fixture", version: "0.1.152", transport: "https", code: "7KQ2M9XDH4TP", credential: null }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setLocale("en");
  add.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  Object.assign(window, { ogb: { workspaces: { probe, add } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function render() {
  await act(async () => root.render(createElement(OwnServerLink, {
    onBack: null, onConnected: connected,
    start: { address: link, locked: false, title: "Connect" },
  })));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}

const button = () => host.querySelector<HTMLButtonElement>("[data-own-server-connect]")!;
const submit = () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

it("sends only one connection IPC when two submits occur before React renders busy", async () => {
  await render();
  expect(button().disabled).toBe(false);
  await act(async () => { submit(); submit(); });
  expect(add).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith("link", link, "");
  expect(button().disabled).toBe(true);
  await act(async () => settle({ outcome: "connected", label: "Fixture" }));
  expect(connected).toHaveBeenCalledTimes(1);
});

it("allows retry after cancellation without discarding the full pairing link", async () => {
  await render();
  await act(async () => { submit(); submit(); });
  await act(async () => settle(false));
  expect(button().disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>("[data-own-server-link]")!.value).toBe(link);
  await act(async () => { submit(); submit(); });
  expect(add).toHaveBeenCalledTimes(2);
  await act(async () => settle(false));
  expect(connected).not.toHaveBeenCalled();
});

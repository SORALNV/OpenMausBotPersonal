import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { YourComputerSettings, yourComputerSettingsRoute } from "./your-computer-settings.ts";
import { askToUseYourComputer, resolveYourComputerAsk } from "./your-computer-consent.ts";
import type { RouteContext } from "./routes/table.ts";
import type { Store } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(host = "test-host-a") {
  const dir = mkdtempSync(join(tmpdir(), "omb-your-computer-")); dirs.push(dir);
  const privateDir = join(dir, "private");
  const fingerprint = createHash("sha256").update(host).digest("hex");
  return { privateDir, fingerprint, settings: new YourComputerSettings(privateDir, fingerprint) };
}

it("defaults off, requires a one-use confirmation, persists on restart, and revokes", () => {
  const { privateDir, fingerprint, settings } = fixture();
  const initial = settings.snapshot();
  expect(initial.enabled).toBe(false);
  expect(initial.scope).toEqual(["画面の表示", "クリック", "キー入力", "文字入力", "スクロール", "アプリの起動・切替"]);
  expect(() => settings.configure({ enabled: true })).toThrow("確認が期限切れ");
  const confirmation = settings.challenge();
  expect(confirmation.deviceId).toBe(initial.deviceId);
  expect(settings.configure({ enabled: true, confirmationId: confirmation.confirmationId }).enabled).toBe(true);
  expect(new YourComputerSettings(privateDir, fingerprint).snapshot()).toMatchObject({ enabled: true, deviceId: initial.deviceId });
  expect(settings.configure({ enabled: false }).enabled).toBe(false);
  expect(new YourComputerSettings(privateDir, fingerprint).snapshot()).toMatchObject({ enabled: false, deviceId: initial.deviceId });
});

it("does not transfer the permission to another connection, even on the same physical PC", () => {
  const first = fixture("host-a");
  const confirmation = first.settings.challenge();
  first.settings.configure({ enabled: true, confirmationId: confirmation.confirmationId });
  const other = fixture("host-a");
  copyFileSync(join(first.privateDir, "your-computer-permission.json"), join(other.privateDir, "your-computer-permission.json"));
  const moved = other.settings.snapshot();
  expect(moved.enabled).toBe(false);
  expect(moved.deviceId).not.toBe(first.settings.snapshot().deviceId);
  const otherPc = fixture("host-b");
  expect(otherPc.settings.snapshot().enabled).toBe(false);
});

it("shares one PC permission across all bot calls without changing other approvals", async () => {
  const { settings } = fixture();
  let message: { id: string; card?: { requestId?: string; title?: string } } | undefined;
  const appendMessage = vi.fn((_threadId: string, input: { card?: { requestId?: string; title?: string } }) => (message = { ...input, id: "ask-card" }));
  const store = {
    groupByThread: () => undefined,
    appendMessage,
    messagesFor: () => message ? [message] : [],
    patchMessage: vi.fn(),
  } as unknown as Store;
  expect(settings.enabled()).toBe(false);
  const denied = expect(askToUseYourComputer({ store, alwaysAllowed: () => settings.enabled() }, undefined, { threadId: "off-bot-thread", generation: "off" })).rejects.toThrow();
  expect(message?.card?.title).toBe("I need to use your computer's screen for this. Allow once?");
  expect(resolveYourComputerAsk(message?.card?.requestId ?? "", "deny")).toBe(true);
  await denied;
  const promptedOnce = appendMessage.mock.calls.length;
  const confirmation = settings.challenge();
  settings.configure({ enabled: true, confirmationId: confirmation.confirmationId });
  for (const threadId of ["bot-a-thread", "bot-b-thread"]) {
    await expect(askToUseYourComputer({ store, alwaysAllowed: () => settings.enabled() }, undefined, { threadId, generation: threadId })).resolves.toBeUndefined();
  }
  expect(appendMessage).toHaveBeenCalledTimes(promptedOnce);
  settings.configure({ enabled: false });
  expect(settings.enabled()).toBe(false);
});

it("serves status and confirmation only to an owner, and cannot enable through the phone client scope", async () => {
  const { settings } = fixture();
  const route = yourComputerSettingsRoute(settings);
  const call = async (path: string, method: string, auth: RouteContext["auth"], body: unknown = {}) => {
    let result: { status: number; body: unknown } | undefined;
    const context = { req: {}, res: { setHeader: vi.fn() }, path, method, auth, readBody: async () => body,
      json: (_res: unknown, status: number, value: unknown) => { result = { status, body: value }; } } as unknown as RouteContext;
    await route(context);
    return result!;
  };
  const owner = { kind: "loopback", scopes: ["admin", "client"] } as const;
  const service = { kind: "loopback", trust: "service", scopes: ["client"] } as const;
  expect((await call("/api/your-computer/settings", "GET", owner)).status).toBe(200);
  expect((await call("/api/your-computer/settings", "GET", service)).status).toBe(403);
  const challenge = await call("/api/your-computer/confirmation", "POST", owner);
  expect(challenge.status).toBe(200);
  const confirmationId = (challenge.body as { confirmationId: string }).confirmationId;
  expect((await call("/api/your-computer/settings", "PUT", service, { enabled: true, confirmationId })).status).toBe(403);
  expect(settings.snapshot().enabled).toBe(false);
});

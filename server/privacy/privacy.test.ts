import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { PrivacyGuard } from "./guard.ts";
import { PrivacyVault } from "./vault.ts";
import { LocalDetector, type Detector } from "./detector.ts";
import { installPrivacyBoundary, protectedChatFetch, restorePrivacyDisplay } from "./boundary.ts";
import { privacyDriverRefusal, privacyRequestBlocked, PrivacyBlocked } from "./policy.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { OpenAICompatDriver } from "../drivers/openai-compat.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { NATIVE_DIR, ensureDirs } from "../config.ts";
import { existsSync } from "node:fs";
import { removeTempDir } from "../testing/cleanup.ts";

const dirs: string[] = [];
let cleanup: (() => void) | undefined;
afterEach(async () => {
  cleanup?.(); cleanup = undefined;
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
function fixture(detector: Detector = { detect: async texts => texts.map(() => []), close() {} }) {
  const dir = mkdtempSync(join(tmpdir(), "omb-privacy-")); dirs.push(dir);
  const vault = new PrivacyVault(dir);
  return { dir, vault, guard: new PrivacyGuard(vault, detector) };
}
const cases = [
  ["氏名: 星野 架空", "星野 架空", "人物"],
  ["私は星野架空です。", "星野架空", "人物"],
  ["😀担当者は星野架空です。", "星野架空", "人物"],
  ["住所: 東京都架空区試験町1-2-3", "東京都架空区試験町1-2-3", "住所"],
  ["メール: hoshino@example.invalid", "hoshino@example.invalid", "メール"],
  ["電話: 090-1234-5678", "090-1234-5678", "電話"],
  ["連絡先: +81-90-1234-5678", "+81-90-1234-5678", "電話"],
  ["口座番号: 1234567", "1234567", "口座"],
  ["APIキー: sk-proj-SYNTHETICKEY01234567890", "sk-proj-SYNTHETICKEY01234567890", "秘密"],
  ["password=synthetic-password", "synthetic-password", "秘密"],
  ['{"api_key":"synthetic-value"}', "synthetic-value", "秘密"],
  ["-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----", "SYNTHETIC", "秘密"],
];

describe("local pseudonymization", () => {
  it.each(cases)("supplements Japanese detection: %s", async (input, raw, label) => {
    const { guard } = fixture();
    const value = JSON.stringify(await guard.protect("thread", { messages: [{ role: "user", content: input }] }));
    expect(value).not.toContain(raw);
    expect(value).toContain(`⟦${label}_001⟧`);
  });
  it("keeps aliases across history, memory, results, later requests and a restart", async () => {
    const { dir, guard, vault } = fixture();
    writeFileSync(join(dir, "terms.json"), JSON.stringify([{ text: "星野 架空", label: "private_person" }]), { mode: 0o600 });
    const payload = { messages: [
      { role: "system", content: "記憶: 星野 架空" },
      { role: "user", content: "過去: 星野 架空 hoshino@example.invalid" },
      { role: "assistant", content: "星野 架空" },
      { role: "tool", tool_call_id: "result-1", content: "星野 架空 hoshino@example.invalid" },
    ] };
    const result = JSON.stringify(await guard.protect("a", payload));
    expect(result).not.toContain("星野"); expect(result).not.toContain("hoshino@");
    expect(result.match(/人物_001/g)).toHaveLength(4);
    const again = JSON.stringify(await guard.protect("a", { content: "星野 架空" }));
    expect(again).toContain("人物_001");
    expect(new PrivacyVault(dir).restoreForDisplay("a", "⟦人物_001⟧")).toBe("星野 架空");
    expect(vault.restoreForDisplay("other", "⟦人物_001⟧")).toBe("⟦人物_001⟧");
    expect(await guard.protect("helper", "星野 架空")).toBe("⟦人物_001⟧");
    expect(vault.restoreForDisplay("helper", "⟦人物_001⟧")).toBe("星野 架空");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "vault.json")).mode & 0o777).toBe(0o600);
  });
  it("propagates a contextual model detection backwards into shorter occurrences", async () => {
    const { guard } = fixture({ detect: async texts => texts.map(t => t === "担当は架空太郎です" ? [{ start: 3, end: 7, label: "private_person" }] : []), close() {} });
    expect(await guard.protect("t", ["架空太郎", "担当は架空太郎です"])).toEqual(["⟦人物_001⟧", "担当は⟦人物_001⟧です"]);
  });
  it("does not re-mask a registered word inside a generated alias", async () => {
    const { dir, guard } = fixture();
    writeFileSync(join(dir, "terms.json"), JSON.stringify([{ text: "人物", label: "private_person" }]), { mode: 0o600 });
    const value = await guard.protect("t", "人物");
    expect(value).toBe("⟦人物_001⟧");
    expect(await guard.protect("t", value)).toBe(value);
  });
  it("preserves known aliases without dropping adjacent detected text", async () => {
    const { guard } = fixture({ detect: async texts => texts.map(t => t.includes("⟦") ? [{ start: 0, end: t.length, label: "secret" }] : []), close() {} });
    await guard.protect("t", "氏名: 星野 架空");
    const result = await guard.protect("t", "漏れ⟦人物_001⟧秘密");
    expect(result).not.toContain("漏れ"); expect(result).not.toContain("秘密⟧");
    expect(result).toContain("⟦人物_001⟧");
  });
  it("does not exempt forged numeric aliases from detected or registered secret spans", async () => {
    const text = "口座番号: ⟦口座_1234567⟧";
    const { guard } = fixture({ detect: async texts => texts.map(t => t === text ? [{ start: t.indexOf("1234567"), end: t.indexOf("1234567") + 7, label: "account_number" }] : []), close() {} });
    expect(await guard.protect("t", text)).not.toContain("1234567");
  });
  it.each([[[{ start: -1, end: 5, label: "secret" }]], [[{ start: 0, end: 999, label: "secret" }]], [[] , []], [[{ start: 0, end: 1, label: "unknown" }]]].map(spans => ({ spans })))("rejects malformed detector output", async ({ spans }) => {
    const { guard } = fixture({ detect: async () => spans as never, close() {} });
    await expect(guard.protect("t", "synthetic")).rejects.toThrow(PrivacyBlocked);
  });
  it.each([
    { content: [{ type: "image_url", image_url: { url: "https://example.invalid/a.png" } }] },
    { content: "data:image/png;base64,AAAA" }, { audio: "AAAA" }, { file_data: "AAAA" }, Buffer.from("binary"),
  ])("blocks unsupported media without invoking the detector", async payload => {
    const detect = vi.fn(); const { guard } = fixture({ detect, close() {} });
    await expect(guard.protect("t", payload)).rejects.toThrow(PrivacyBlocked);
    expect(detect).not.toHaveBeenCalled();
  });
  it("fails closed on malformed or publicly readable protected terms", async () => {
    const { dir, guard } = fixture(); const file = join(dir, "terms.json");
    writeFileSync(file, "broken", { mode: 0o600 });
    await expect(guard.protect("t", "synthetic")).rejects.toThrow(PrivacyBlocked);
    writeFileSync(file, "[]"); chmodSync(file, 0o644);
    await expect(guard.protect("t", "synthetic")).rejects.toThrow(PrivacyBlocked);
  });
  it("rejects oversized requests before detection", async () => {
    const { guard } = fixture();
    await expect(guard.protect("t", "x".repeat(100_001))).rejects.toThrow(PrivacyBlocked);
  });
});

describe("actual HTTP send boundary", () => {
  function network(detector?: Detector) {
    vi.stubEnv("OMB_PRIVACY_MODE", "strict");
    const sent = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "⟦人物_001⟧へ返信" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", sent);
    const local = fixture(detector);
    cleanup = installPrivacyBoundary(local.guard);
    return { sent, ...local };
  }
  it("only passes aliases to transport, separates display restoration, and blocks raw HTTP", async () => {
    const { sent, vault } = network();
    await protectedChatFetch("https://example.invalid/v1/chat/completions", { body: JSON.stringify({ messages: [{ content: "氏名: 星野 架空 hoshino@example.invalid" }] }) }, "t");
    const wire = String((sent.mock.calls as unknown as [string, RequestInit][])[0][1].body);
    expect(wire).not.toContain("星野"); expect(wire).not.toContain("hoshino@");
    expect(wire).not.toContain("vault");
    expect(restorePrivacyDisplay("t", "⟦人物_001⟧へ返信")).toBe("星野 架空へ返信");
    expect(vault.restoreForDisplay("x", "⟦人物_001⟧")).toBe("⟦人物_001⟧");
    await expect(fetch("https://example.invalid", { method: "POST", body: "原文" })).rejects.toThrow(PrivacyBlocked);
    expect(sent).toHaveBeenCalledTimes(1);
    expect((sent.mock.calls as unknown as [string, RequestInit][])[0][1].redirect).toBe("error");
  });
  it("does not send anything when detection fails", async () => {
    const { sent } = network({ detect: async () => { throw new Error("synthetic private error"); }, close() {} });
    await expect(protectedChatFetch("https://example.invalid/chat/completions", { body: '{"content":"原文"}' }, "t")).rejects.toThrow("原文は送信していません");
    expect(sent).not.toHaveBeenCalled();
  });
  it.each(["http://example.invalid/chat/completions", "https://example.invalid/chat/completions?private=raw", "https://user:password@example.invalid/chat/completions", "https://example.invalid/responses"])("rejects unsafe destinations: %s", async url => {
    const { sent } = network();
    await expect(protectedChatFetch(url, { body: "{}" }, "t")).rejects.toThrow(PrivacyBlocked);
    expect(sent).not.toHaveBeenCalled();
  });
  it("protects the real driver, its history and helper calls, disables tools and native logs", async () => {
    const { sent } = network(); ensureDirs();
    const instance = await OpenAICompatDriver.create({ instanceId: "privacy", displayName: "Privacy", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://example.invalid/v1", model: "fixture", managedModels: ["fixture"] }), environment: { OPENAI_COMPAT_API_KEY: "fixture-key" } });
    const events: RuntimeEvent[] = []; instance.adapter.onEvent(e => events.push(e));
    await instance.adapter.sendTurn({ threadId: "privacy-wire", text: "氏名: 星野 架空", system: "記憶: hoshino@example.invalid",
      transcript: [{ role: "user", text: "過去の電話 090-1234-5678" }, { role: "assistant", text: "口座番号: 1234567" }],
      integrations: { custom: { forbidden: { command: "/never-spawn-this", args: [], env: {} } } } });
    await vi.waitFor(() => expect(events.some(e => e.type === "turn.completed")).toBe(true));
    const wire = JSON.stringify(sent.mock.calls);
    for (const raw of ["星野", "hoshino@", "090-1234-5678", "1234567"]) expect(wire).not.toContain(raw);
    expect(wire).not.toContain('"tools":');
    expect(instance.adapter.capabilities.customMcp).toBe(false);
    expect(existsSync(join(NATIVE_DIR, "privacy-wire.ndjson"))).toBe(false);
    await instance.generateText!("password=synthetic-password");
    expect(JSON.stringify(sent.mock.calls)).not.toContain("synthetic-password");
    await expect(instance.adapter.sendTurn({ threadId: "media", text: "test", images: [{ path: "/never-read", mime: "image/png", bytes: 100 }] })).rejects.toThrow(PrivacyBlocked);
    await instance.dispose();
  });
  it("hides provider error bodies even if the provider echoes the request", async () => {
    const { sent } = network();
    sent.mockImplementation(async () => new Response("synthetic private echo", { status: 400 }));
    const result = await protectedChatFetch("https://example.invalid/chat/completions", { body: "{}" }, "t");
    expect(await result.text()).not.toContain("synthetic private echo");
  });
});

describe("strict bypass policy", () => {
  it("does not instantiate CLI drivers", async () => {
    vi.stubEnv("OMB_PRIVACY_MODE", "strict"); const create = vi.fn();
    const registry = new ProviderRegistry([{ ...ClaudeDriver, create }]);
    await registry.load({ claude: { driver: ClaudeDriver.driverKind } });
    expect(create).not.toHaveBeenCalled(); expect(registry.get("claude")).toBeNull();
    expect(registry.entries()[0].shadow?.reason).toContain("厳格モード");
    for (const kind of ["codex", "pi", "muse-code", "custom-acp", "hermes", "unknown"]) expect(privacyDriverRefusal(kind)).toBeTruthy();
  });
  it.each(["/api/live/calls", "/api/tts", "/api/attachments/a", "/api/internal/agents/mcp", "/api/decider/test", "/api/config", "/api/bots/a/computer/provision", "/api/bots/a/memory/open"])("blocks unsupported service route %s", path => {
    vi.stubEnv("OMB_PRIVACY_MODE", "strict");
    expect(privacyRequestBlocked({ method: "POST", headers: { "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage, new URL(path, "http://127.0.0.1"))).toBe(true);
  });
  it("kills a hanging local worker on timeout without returning plaintext", async () => {
    vi.stubEnv("OMB_PRIVACY_PYTHON", process.execPath); vi.stubEnv("OMB_PRIVACY_CHECKPOINT", "/synthetic");
    const { dir } = fixture(); const file = join(dir, "hang.mjs");
    writeFileSync(file, "setInterval(() => {}, 1000)"); vi.stubEnv("OMB_PRIVACY_WORKER", file);
    const detector = new LocalDetector(30, { file: process.execPath, args: [file] });
    await expect(detector.detect(["synthetic private"])).rejects.toThrow(PrivacyBlocked);
    detector.close();
  });
  it("blocks transport when the GPU worker fails to initialize", async () => {
    vi.stubEnv("OMB_PRIVACY_MODE", "strict");
    vi.stubEnv("OMB_PRIVACY_PYTHON", process.execPath); vi.stubEnv("OMB_PRIVACY_CHECKPOINT", "/synthetic");
    const { dir } = fixture(); const file = join(dir, "gpu-error.mjs");
    writeFileSync(file, 'console.log(JSON.stringify({ error: "local detector initialization failed" }))');
    vi.stubEnv("OMB_PRIVACY_WORKER", file);
    const detector = new LocalDetector(1_000, { file: process.execPath, args: [file] });
    const { guard } = fixture(detector);
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    cleanup = installPrivacyBoundary(guard);
    await expect(protectedChatFetch("https://example.invalid/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "氏名: 星野 架空" }] }),
    }, "fixture")).rejects.toThrow(PrivacyBlocked);
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not write the mapping into payloads or detector files", async () => {
    const { dir, guard } = fixture(); const payload = await guard.protect("t", "氏名: 星野 架空");
    expect(payload).not.toContain("星野");
    expect(readFileSync(join(dir, "vault.json"), "utf8")).toContain("星野");
  });
});

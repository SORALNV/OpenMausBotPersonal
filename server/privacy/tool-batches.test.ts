import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RouteContext } from "../routes/table.ts";
import { PrivacyGuard } from "./guard.ts";
import { PrivacyVault } from "./vault.ts";
import { PersonalPrivacyService } from "./service.ts";
import type { PrivacySpan } from "./rules.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.unstubAllEnvs(); });
function fixture(infer: (texts: string[], call: number) => PrivacySpan[][] = texts => texts.map(() => [])) {
  vi.stubEnv("OMB_PERSONAL_BUILD", "1");
  const dir = mkdtempSync(join(tmpdir(), "omb-tool-batches-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const detector = { detect: vi.fn(async (texts: string[]) => infer(texts, ++calls)), close() {} };
  const service = new PersonalPrivacyService(dir, () => null, detector);
  service.protectThread = thread => thread === "protected";
  cleanup.push(() => service.close());
  const filter = async (value: unknown, active = () => {}) => {
    let result: { status: number; body: any } | undefined;
    const ctx = { path: "/api/internal/privacy-filter", method: "POST", req: {}, res: { setHeader() {} },
      readBody: async () => ({ source: "custom", value }),
      json: (_res: unknown, status: number, body: unknown) => { result = { status, body }; },
    } as unknown as RouteContext;
    await service.internalRoute("protected", active)(ctx);
    return result!;
  };
  return { dir, service, detector, filter };
}

it("protects a 47-post Google Chat result with text and structured mirrors, deduplicating detector inputs", async () => {
  const { filter, detector } = fixture();
  const messages = Array.from({ length: 47 }, (_, index) => ({
    id: `synthetic-${index}`, fingerprint: `fingerprint-${index}`, space: { name: "試験スペース" },
    thread: { id: "synthetic-thread" }, sender: { name: "星野架空" }, text: "氏名: 星野架空\nメール: hoshino@example.invalid",
    timestamp: "2026-10-17T00:00:00Z", firstSeenAt: "2026-10-17T00:00:00Z", direction: "incoming", source: "google-chat-web", unread: false,
  }));
  const result = { messages, coverage: "cached_only" };
  const response = await filter({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } });
  expect(response.status).toBe(200);
  expect(response.body.value.structuredContent.result.messages).toHaveLength(47);
  expect(JSON.stringify(response.body)).not.toMatch(/星野架空|hoshino@example\.invalid/u);
  const inputs = detector.detect.mock.calls.flatMap(([texts]) => texts);
  expect(new Set(inputs).size).toBe(inputs.length);
  expect(inputs.length).toBeLessThan(200);
  expect(detector.detect.mock.calls.every(([texts]) => texts.length <= 512)).toBe(true);
  expect(inputs).not.toContain(JSON.stringify(result));
  expect(response.body.value.content[0].text).toBe(JSON.stringify(response.body.value.structuredContent.result));
});

it("applies a name detected in a later batch to earlier occurrences before returning any result", async () => {
  const { filter, detector } = fixture(texts => texts.map(text => text === "担当は架空太郎です" ? [{ start: 3, end: 7, label: "private_person" }] : []));
  const input = ["架空太郎", ...Array.from({ length: 600 }, (_, index) => `synthetic value ${index}`), "担当は架空太郎です", "架空太郎"];
  const response = await filter(input);
  expect(response.status).toBe(200);
  expect(detector.detect).toHaveBeenCalledTimes(2);
  expect(response.body.value[0]).toBe("⟦人物_001⟧");
  expect(response.body.value.at(-1)).toBe("⟦人物_001⟧");
  expect(response.body.value.at(-2)).toBe("担当は⟦人物_001⟧です");
});

it.each(["failure", "invalid-output"])("returns no partial or raw result after a later batch %s", async failure => {
  const { filter, service } = fixture((texts, call) => {
    if (call === 2) { if (failure === "failure") throw new Error("SYNTHETIC PRIVATE ERROR"); return []; }
    return texts.map(() => []);
  });
  const response = await filter(Array.from({ length: 600 }, (_, index) => `synthetic private ${index}`));
  expect(response.status).toBe(503);
  expect(response.body).not.toHaveProperty("value");
  expect(JSON.stringify(response.body)).not.toContain("synthetic private");
  expect(service.guard.vault.restoreForDisplay("protected", "⟦人物_001⟧")).toBe("⟦人物_001⟧");
});

it.each([
  ["x".repeat(100_001)], Array(16_385).fill("x"),
  { content: [{ type: "image", data: "synthetic" }] },
  { content: [{ type: "resource_link", uri: "https://example.invalid/private" }] },
  ["data:image/png;base64,AAAA"],
].map(input => ({ input })))("keeps total size, structural and binary limits before running any detector", async ({ input }) => {
  const { filter, detector } = fixture();
  expect((await filter(input)).status).toBe(503);
  expect(detector.detect).not.toHaveBeenCalled();
});

it("rechecks the turn after all batches and refuses a revoked result", async () => {
  const { filter } = fixture();
  let checks = 0;
  const response = await filter(Array.from({ length: 600 }, (_, index) => `synthetic ${index}`), () => {
    if (++checks > 1) throw new Error("revoked");
  });
  expect(response.status).toBe(503);
  expect(response.body).not.toHaveProperty("value");
});

it("keeps the strict guard's default 512-string limit", async () => {
  const { dir, detector } = fixture();
  const guard = new PrivacyGuard(new PrivacyVault(dir), detector);
  await expect(guard.protect("strict", Array(513).fill("x"))).rejects.toThrow();
  expect(detector.detect).not.toHaveBeenCalled();
});

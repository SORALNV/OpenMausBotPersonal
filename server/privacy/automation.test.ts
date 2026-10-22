import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PersonalPrivacyService } from "./service.ts";
import { PrivacySettingsStore, validatePrivacySettings } from "./settings.ts";
import { DEFAULT_PERSONAL_PRIVACY } from "../../shared/personal-privacy.ts";
import type { RouteContext } from "../routes/table.ts";
import { assertPrivacyMode } from "./policy.ts";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv("OMB_PERSONAL_BUILD", "1");
  const dir = mkdtempSync(join(tmpdir(), "omb-registered-words-")); dirs.push(dir);
  const run = { routineId: "routine-a", status: "running", target: "bot", runOn: "maus" };
  const service = new PersonalPrivacyService(dir, thread => thread === "scheduled" ? run : null);
  const settings = { ...structuredClone(DEFAULT_PERSONAL_PRIVACY), enabled: true, aliases: [{ replacement: "ユーザーA", variants: ["星野架空", "ほしのかくう", "Kaku Hoshino"], restoreAs: "架空さん" }] };
  const store = new PrivacySettingsStore(dir); store.save(settings);
  const context = (path: string, body: unknown, admin = true) => {
    let result: { status: number; body: any } | undefined;
    const ctx = { req: { headers: { "content-type": "application/json" } }, res: { setHeader: vi.fn() }, path, method: "POST", auth: { kind: "loopback", scopes: admin ? ["admin", "client"] : ["client"] }, readBody: async () => body,
      json: (_res: unknown, status: number, value: unknown) => { result = { status, body: value }; } } as unknown as RouteContext;
    return { ctx, result: () => result! };
  };
  const filter = async (value: unknown, thread = "scheduled", source = "custom", active = () => {}) => {
    const c = context("/api/internal/registered-words", { source, value });
    await service.internalRoute(thread, active)(c.ctx); return c.result();
  };
  return { dir, service, store, settings, run, context, filter };
}

it("replaces only configured variants, keeps unregistered PII, and restores the preferred spelling locally", async () => {
  const { dir, service } = fixture();
  const raw = "星野架空 / ほしのかくう / Kaku Hoshino / unregistered@example.invalid / 090-1234-5678";
  const masked = await service.mask("scheduled", raw) as string;
  expect(masked.match(/⟦ユーザーA⟧/g)).toHaveLength(3);
  for (const variant of ["星野架空", "ほしのかくう", "Kaku Hoshino"]) expect(masked).not.toContain(variant);
  expect(masked).toContain("unregistered@example.invalid / 090-1234-5678");
  expect(service.display("scheduled", masked)).toContain("架空さん");
  expect(service.display("ordinary", masked)).toBe(masked);
  expect(new PersonalPrivacyService(dir, () => null).display("scheduled", "⟦ユーザーA⟧")).toBe("架空さん");
  for (const name of ["settings.json", "vault.json"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
});
it("uses longest literal matches and prevents regex interpretation or replacement cascades", async () => {
  const { service, store, settings } = fixture();
  store.save({ ...settings, aliases: [{ replacement: "B", variants: ["A.*", "A"] }, { replacement: "C", variants: ["B"] }] });
  expect(await service.mask("scheduled", "A.* A B")).toBe("⟦B⟧ ⟦B⟧ ⟦C⟧");
});
it("keeps ordinary chats untouched and applies only selected local routines and sources", async () => {
  const { service, filter, store, settings, run } = fixture();
  expect(await service.prompt("ordinary", "星野架空")).toBe("星野架空");
  expect(await service.prompt("scheduled", "星野架空")).toBe("⟦ユーザーA⟧");
  expect((await filter("星野架空", "ordinary")).body.value).toBe("星野架空");
  store.save({ ...settings, allRoutines: false, routineIds: ["other"], sources: ["custom"] });
  expect((await filter("星野架空")).body.value).toBe("星野架空");
  store.save({ ...settings, sources: ["custom"] });
  expect((await filter("星野架空", "scheduled", "browser")).body.value).toBe("星野架空");
  run.status = "completed";
  expect((await filter("星野架空")).body.value).toBe("星野架空");
});
it("preserves aliases while retiring the old model setting, with an owner-only backup and no model configuration", async () => {
  const { service, dir, settings } = fixture();
  vi.stubEnv("OMB_PRIVACY_PYTHON", "/nonexistent/model-must-never-run");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...settings, modelDetectionEnabled: true }), { mode: 0o600 });
  service.start();
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).not.toHaveProperty("modelDetectionEnabled");
  expect(service.settings.aliases).toEqual(settings.aliases);
  const backups = readdirSync(dir).filter(name => name.startsWith("settings.json.before-model-removal-"));
  expect(backups).toHaveLength(1);
  expect(statSync(join(dir, backups[0])).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(dir, backups[0]), "utf8")).modelDetectionEnabled).toBe(true);
  service.start(); expect(readdirSync(dir).filter(name => name.startsWith("settings.json.before-model-removal-"))).toHaveLength(1);
  expect(await service.mask("a", "星野架空")).toBe("⟦ユーザーA⟧");
});
it("removes the model setting from API responses and protects private rules from paired clients", async () => {
  const { service, settings, context } = fixture();
  const read = context("/api/privacy/settings", null); read.ctx.method = "GET";
  await service.settingsRoute(read.ctx);
  expect(read.result().body).toMatchObject({ mode: "registered-words", settings: { aliases: settings.aliases } });
  expect(read.result().body).not.toHaveProperty("state");
  expect(read.result().body.settings).not.toHaveProperty("modelDetectionEnabled");
  const c = context("/api/privacy/settings", null, false); c.ctx.method = "GET";
  await service.settingsRoute(c.ctx); expect(c.result().status).toBe(403);
  expect(validatePrivacySettings({ ...settings, modelDetectionEnabled: true })).not.toHaveProperty("modelDetectionEnabled");
});
it("does not silently fall back to raw data for removed model endpoints or modes", async () => {
  const { service, context } = fixture();
  const old = context("/api/internal/privacy-filter", { model: true, value: "星野架空" });
  await service.internalRoute("scheduled", () => {})(old.ctx);
  expect(old.result().status).toBe(410); expect(old.result().body).not.toHaveProperty("value");
  vi.stubEnv("OMB_PRIVACY_MODE", "strict"); expect(assertPrivacyMode).toThrow("削除済み");
  vi.stubEnv("OMB_PRIVACY_MODE", "off"); expect(assertPrivacyMode).not.toThrow();
});
it("filters Google Chat results with registered words alone, without changing ordinary input", async () => {
  const { service, filter, store, settings } = fixture();
  store.save({ ...settings, enabled: false }); service.protectThread = thread => thread === "chat";
  const result = await filter({ content: [{ type: "text", text: "星野架空 unregistered@example.invalid" }], structuredContent: { sender: "Kaku Hoshino" } }, "chat");
  expect(result.status).toBe(200); expect(JSON.stringify(result.body.value)).not.toMatch(/星野架空|Kaku Hoshino/u);
  expect(JSON.stringify(result.body.value)).toContain("unregistered@example.invalid");
  expect(await service.prompt("chat", "星野架空")).toBe("星野架空");
});
it("rejects corrupt settings, opaque results and revoked turns without forwarding originals", async () => {
  const { filter, service, context, dir } = fixture();
  for (const value of [{ content: [{ type: "image", data: "synthetic" }] }, "A".repeat(100001)]) {
    const result = await filter(value); expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("value");
  }
  let checks = 0;
  const revoked = await filter("星野架空", "scheduled", "custom", () => { if (++checks > 1) throw new Error("revoked"); });
  expect(revoked.status).toBe(503); expect(revoked.body).not.toHaveProperty("value");
  writeFileSync(join(dir, "settings.json"), "invalid", { mode: 0o600 });
  expect((await filter("星野架空")).status).toBe(503);
  expect(await service.prompt("ordinary", "星野架空")).toBe("星野架空");
  const c = context("/api/internal/registered-words", { source: "custom", value: "星野架空" });
  await expect(service.internalRoute("scheduled", () => { throw new Error("revoked"); })(c.ctx)).rejects.toThrow("revoked");
});
it("keeps HTTP MCP behind the local word substitution proxy only for selected tools", () => {
  const { service } = fixture();
  const integrations = { agents: { command: process.execPath, args: [], env: { OMB_COMMS_TOKEN: "synthetic-bearer", OMB_HARNESS_URL: "http://127.0.0.1:1234" } }, custom: { chat: { type: "http" as const, url: "http://127.0.0.1:4321/mcp", headers: { Authorization: "Bearer synthetic-only" } } } };
  expect(service.wrap("ordinary", integrations)).toBe(integrations);
  expect(service.wrap("scheduled", integrations)!.custom!.chat).not.toHaveProperty("url");
  expect(JSON.stringify(service.wrap("scheduled", integrations))).toContain("privacy-mcp-proxy");
});
it("rejects ambiguous and reserved replacement names", () => {
  const { settings } = fixture();
  for (const aliases of [[{ replacement: "", variants: ["A"] }], [{ replacement: "人物_001", variants: ["A"] }], [{ replacement: "A", variants: ["B"] }, { replacement: "C", variants: ["B"] }]]) expect(() => validatePrivacySettings({ ...settings, aliases })).toThrow();
});

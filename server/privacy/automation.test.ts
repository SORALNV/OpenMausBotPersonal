import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PersonalPrivacyService } from "./service.ts";
import { PrivacySettingsStore, validatePrivacySettings } from "./settings.ts";
import { DEFAULT_PERSONAL_PRIVACY } from "../../shared/personal-privacy.ts";
import type { RouteContext } from "../routes/table.ts";

const dirs: string[] = [];
const services: PersonalPrivacyService[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function fixture(fails = false) {
  vi.stubEnv("OMB_PERSONAL_BUILD", "1");
  const dir = mkdtempSync(join(tmpdir(), "omb-automatic-privacy-")); dirs.push(dir);
  const detector = { detect: vi.fn(async (texts: string[]) => { if (fails) throw new Error("SYNTHETIC detector error"); return texts.map(() => []); }), close() {} };
  const run = { routineId: "routine-a", status: "running", target: "bot", runOn: "maus" };
  const service = new PersonalPrivacyService(dir, thread => thread === "scheduled" ? run : null, detector); services.push(service);
  const settings = { ...structuredClone(DEFAULT_PERSONAL_PRIVACY), enabled: true, aliases: [{ replacement: "ユーザーA", variants: ["星野架空", "ほしのかくう", "Kaku Hoshino"] }] };
  const store = new PrivacySettingsStore(dir); store.save(settings);
  const context = (path: string, body: unknown, admin = true) => {
    let result: { status: number; body: any } | undefined;
    const ctx = { req: { headers: { "content-type": "application/json" } }, res: { setHeader: vi.fn() }, path, method: "POST", auth: { kind: "loopback", scopes: admin ? ["admin", "client"] : ["client"] }, readBody: async () => body,
      json: (_res: unknown, status: number, value: unknown) => { result = { status, body: value }; } } as unknown as RouteContext;
    return { ctx, result: () => result! };
  };
  const filter = async (value: unknown, thread = "scheduled", source = "custom") => {
    const c = context("/api/internal/privacy-filter", { source, value });
    await service.internalRoute(thread, () => {})(c.ctx); return c.result();
  };
  return { dir, detector, service, store, settings, run, context, filter };
}

it("maps literal Japanese, kana and English variants to one chosen alias, with scoped persistent display restoration", async () => {
  const { dir, service } = fixture();
  const raw = "星野架空 / ほしのかくう / Kaku Hoshino / hoshino@example.invalid / 口座番号: 1234567";
  const masked = await service.mask("scheduled", raw) as string;
  expect(masked.match(/⟦ユーザーA⟧/g)).toHaveLength(3);
  for (const original of ["星野架空", "ほしのかくう", "Kaku Hoshino", "hoshino@", "1234567"]) expect(masked).not.toContain(original);
  expect(service.display("scheduled", masked)).toContain("星野架空");
  expect(service.display("ordinary", masked)).not.toContain("星野架空");
  const restarted = new PersonalPrivacyService(dir, () => null); services.push(restarted);
  expect(restarted.display("scheduled", "⟦ユーザーA⟧")).toBe("星野架空");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of ["settings.json", "vault.json"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
});
it("uses longest literal matches, escapes regular expressions and does not cascade replacements", async () => {
  const { service, store, settings } = fixture();
  store.save({ ...settings, aliases: [{ replacement: "B", variants: ["A.*", "A"] }, { replacement: "C", variants: ["B"] }] });
  expect(await service.mask("scheduled", "A.* A B")).toBe("⟦B⟧ ⟦B⟧ ⟦C⟧");
});
it("automatically filters tool answers, structured content and keys before the mock AI boundary", async () => {
  const { filter } = fixture();
  const result = await filter({ content: [{ type: "text", text: "星野架空 ほしのかくう" }], structuredContent: { "Kaku Hoshino": { email: "hoshino@example.invalid", secret: "sk-proj-SYNTHETIC123456789" } } });
  expect(result.status).toBe(200);
  const boundary = JSON.stringify(result.body.value);
  for (const raw of ["星野架空", "ほしのかくう", "Kaku Hoshino", "hoshino@", "SYNTHETIC123456789"]) expect(boundary).not.toContain(raw);
  expect(boundary).toContain("ユーザーA");
});
it("leaves ordinary chat alone and filters only selected routines and sources", async () => {
  const { service, detector, filter, store, settings, run } = fixture();
  expect(await service.prompt("ordinary", "星野架空")).toBe("星野架空");
  expect(detector.detect).not.toHaveBeenCalled();
  expect((await filter("星野架空", "ordinary")).body.value).toBe("星野架空");
  store.save({ ...settings, allRoutines: false, routineIds: ["other"], sources: ["custom"] });
  expect((await filter("星野架空")).body.value).toBe("星野架空");
  store.save({ ...settings, sources: ["custom"] });
  expect((await filter("星野架空", "scheduled", "browser")).body.value).toBe("星野架空");
  run.status = "completed";
  expect((await filter("星野架空")).body.value).toBe("星野架空");
});
it("warms the local model when enabled settings are saved and when the app starts again", async () => {
  const { service, settings, context, detector, dir } = fixture();
  const c = context("/api/privacy/settings", settings); c.ctx.method = "PUT";
  await service.settingsRoute(c.ctx);
  expect(c.result().status).toBe(200); expect(detector.detect).toHaveBeenCalledWith([""]);
  await Promise.resolve(); await Promise.resolve();
  const before = detector.detect.mock.calls.length;
  const restarted = new PersonalPrivacyService(dir, () => null, detector); services.push(restarted);
  restarted.start(); expect(detector.detect.mock.calls.length).toBeGreaterThan(before);
});
it("disables automatic detection for Google Chat feeds and forced tool results while retaining literal rules", async () => {
  const { service, settings, store, detector, filter, context } = fixture(true);
  store.save({ ...settings, modelDetectionEnabled: false, toolFiltering: true });
  service.protectThread = () => true;
  service.start();
  const raw = "星野架空 hoshino@example.invalid 090-1234-5678";
  expect(await service.mask("chat", raw, ["星野架空"])).toBe("⟦ユーザーA⟧ hoshino@example.invalid 090-1234-5678");
  const result = await filter({ content: [{ type: "text", text: raw }], structuredContent: { "Kaku Hoshino": raw } }, "chat");
  expect(result.status).toBe(200);
  expect(result.body.value.structuredContent["⟦ユーザーA⟧"]).toBe("⟦ユーザーA⟧ hoshino@example.invalid 090-1234-5678");
  expect(result.body.value.content[0].text).toContain("hoshino@example.invalid");
  expect(await service.prompt("ordinary", raw)).toBe(raw);
  expect(detector.detect).not.toHaveBeenCalled();
  const read = context("/api/privacy/settings", null); read.ctx.method = "GET";
  await service.settingsRoute(read.ctx);
  expect(read.result().body.state).toBe("off");
});
it("closes the detector on disable and stays off even when an earlier warmup finishes", async () => {
  const { service, settings, detector, context } = fixture();
  let finish!: (spans: never[][]) => void;
  detector.detect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const close = vi.spyOn(detector, "close");
  service.start(); expect(detector.detect).toHaveBeenCalledOnce();
  const c = context("/api/privacy/settings", { ...settings, modelDetectionEnabled: false }); c.ctx.method = "PUT";
  await service.settingsRoute(c.ctx);
  expect(close).toHaveBeenCalledOnce();
  expect(c.result().body.settings.aliases).toEqual(settings.aliases);
  expect(c.result().body.state).toBe("off");
  finish([[]]); await Promise.resolve(); await Promise.resolve();
  const read = context("/api/privacy/settings", null); read.ctx.method = "GET";
  await service.settingsRoute(read.ctx); expect(read.result().body.state).toBe("off");
  expect(validatePrivacySettings({ ...settings, modelDetectionEnabled: undefined }).modelDetectionEnabled).toBe(true);
  expect(() => validatePrivacySettings({ ...settings, modelDetectionEnabled: "false" })).toThrow();
});
it("fails closed on model errors, corrupt settings, large/binary results, and a revoked turn", async () => {
  const { filter, service, context, dir } = fixture(true);
  for (const value of ["星野架空", { content: [{ type: "image", data: "synthetic" }] }, "A".repeat(100001)]) {
    const result = await filter(value); expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain("星野架空");
  }
  writeFileSync(join(dir, "settings.json"), "invalid", { mode: 0o600 });
  expect((await filter("星野架空")).status).toBe(503);
  expect(await service.prompt("ordinary", "星野架空")).toBe("星野架空");
  const c = context("/api/internal/privacy-filter", { source: "custom", value: "星野架空" });
  await expect(service.internalRoute("scheduled", () => { throw new Error("revoked"); })(c.ctx)).rejects.toThrow("revoked");
});
it("does not expose settings to a paired client and rejects ambiguous or reserved aliases", async () => {
  const { service, context, settings } = fixture();
  const c = context("/api/privacy/settings", settings, false); c.ctx.method = "GET";
  await service.settingsRoute(c.ctx); expect(c.result().status).toBe(403); expect(JSON.stringify(c.result())).not.toContain("星野");
  for (const aliases of [[{ replacement: "", variants: ["A"] }], [{ replacement: "人物_001", variants: ["A"] }], [{ replacement: "A", variants: ["B"] }, { replacement: "C", variants: ["B"] }]]) {
    expect(() => validatePrivacySettings({ ...settings, aliases })).toThrow();
  }
});

it("wraps registered HTTP MCP behind the local filter without leaving a native URL bypass, keeping ordinary turns untouched", () => {
  const { service } = fixture();
  const integrations = { agents: { command: process.execPath, args: [], env: { OMB_COMMS_TOKEN: "synthetic-bearer", OMB_HARNESS_URL: "http://127.0.0.1:1234" } }, custom: { chat: { type: "http" as const, url: "http://127.0.0.1:4321/mcp", headers: { Authorization: "Bearer synthetic-only" } } } };
  expect(service.wrap("ordinary", integrations)).toBe(integrations);
  const wrapped = service.wrap("scheduled", integrations)!;
  expect(wrapped.custom!.chat).not.toHaveProperty("url");
  expect(JSON.stringify((wrapped.custom!.chat as { args: string[] }).args)).not.toContain("synthetic-bearer");
  expect(JSON.stringify(wrapped.custom!.chat)).toContain("privacy-mcp-proxy");
});

it("keeps literal rules fast while explicitly opted-in tools use the model before the AI boundary", async () => {
  const { service, store, settings, context, detector, dir } = fixture();
  store.save({ ...settings, enabled: false, toolFiltering: true, aliases: [{ replacement: "利用者", variants: ["星野架空", "ほしのかくう", "Kaku Hoshino"], restoreAs: "架空さん" }] });
  const read = async (model: boolean, value: unknown) => {
    const c = context("/api/internal/privacy-filter", { source: "custom", value, model });
    await service.internalRoute("ordinary", () => {})(c.ctx); return c.result();
  };
  const raw = { content: [{ type: "text", text: "ほしのかくう hoshino@example.invalid" }], structuredContent: { sender: "Kaku Hoshino" } };
  const literal = await read(false, raw);
  expect(literal.status).toBe(200); expect(JSON.stringify(literal.body)).not.toMatch(/ほしのかくう|Kaku Hoshino/);
  expect(detector.detect).not.toHaveBeenCalled();
  const protectedResult = await read(true, raw);
  expect(protectedResult.status).toBe(200); expect(JSON.stringify(protectedResult.body)).not.toContain("hoshino@example.invalid");
  expect(detector.detect).toHaveBeenCalled();
  expect(service.display("ordinary", "⟦利用者⟧")).toBe("架空さん");
  expect(service.literals("ordinary", "⟦利用者⟧")).toBe("⟦利用者⟧");
  const restarted = new PersonalPrivacyService(dir, () => null, detector); services.push(restarted);
  expect(restarted.display("ordinary", "⟦利用者⟧")).toBe("架空さん");
  expect(await service.prompt("ordinary", "星野架空")).toBe("星野架空");
  expect((await read(true, { content: [{ type: "image", data: "synthetic" }] })).status).toBe(503);
  service.protectThread = () => true;
  expect(await service.prompt("ordinary", "星野架空")).toBe("星野架空");
});

it("never returns the original when an explicitly requested tool filter is disabled or fails", async () => {
  const { service, context, store, settings } = fixture(true);
  const read = async () => { const c = context("/api/internal/privacy-filter", { source: "custom", value: "星野架空", model: true }); await service.internalRoute("ordinary", () => {})(c.ctx); return c.result(); };
  expect((await read()).status).toBe(503);
  store.save({ ...settings, toolFiltering: true });
  const response = await read(); expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain("星野架空");
});

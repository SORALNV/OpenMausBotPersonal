import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersonalPrivacyRoute } from "./personal.ts";
import { PersonalPrivacyService } from "./service.ts";
import { PrivacySettingsStore } from "./settings.ts";
import { DEFAULT_PERSONAL_PRIVACY } from "../../shared/personal-privacy.ts";
import type { RouteContext } from "../routes/table.ts";
import { requiredScope } from "../request-auth.ts";
import { denyReason } from "../../companion/src/routes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(fails = false) {
  const dir = mkdtempSync(join(tmpdir(), "omb-personal-privacy-")); dirs.push(dir);
  const service = new PersonalPrivacyService(dir, () => null);
  new PrivacySettingsStore(dir).save({ ...DEFAULT_PERSONAL_PRIVACY, aliases: [{ replacement: "利用者", variants: ["星野 架空"], restoreAs: "架空さん" }] });
  if (fails) vi.spyOn(service, "mask").mockRejectedValue(new Error());
  const route = createPersonalPrivacyRoute(id => ["a", "b"].includes(id), { enabled: true, service });
  const call = async (thread: string, action: string, text: string) => {
    let result: { status: number; body: { text?: string } } | undefined;
    const context = {
      req: { headers: { "content-type": "application/json" } }, res: { setHeader: vi.fn() },
      path: `/api/threads/${thread}/privacy/${action}`, method: "POST", readBody: async () => ({ text }),
      json: (_res: unknown, status: number, body: { text?: string }) => { result = { status, body }; },
    } as unknown as RouteContext;
    await route(context);
    return result!;
  };
  return { call };
}
it("prepares text without sending it and restores only within its conversation", async () => {
  const { call } = fixture();
  const result = await call("a", "mask", "氏名: 星野 架空 hoshino@example.invalid");
  expect(result.status).toBe(200);
  expect(result.body.text).not.toContain("架空さん");
  expect(result.body.text).toContain("hoshino@example.invalid");
  expect((await call("a", "display", result.body.text!)).body.text).toContain("架空さん");
  expect((await call("b", "display", result.body.text!)).body.text).not.toContain("架空さん");
  expect((await call("unknown", "display", result.body.text!)).status).toBe(404);
});
it("fails closed instead of returning raw text when the literal substitution fails", async () => {
  const { call } = fixture(true);
  const result = await call("a", "mask", "氏名: 星野 架空");
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain("星野");
});
it("allows only exact text operations through the paired phone surface", () => {
  for (const action of ["mask", "display"]) {
    const path = `/api/threads/a/privacy/${action}`;
    expect(requiredScope("POST", path)).toBe("client");
    expect(denyReason({ path, method: "POST", authenticated: true })).toBeNull();
    expect(denyReason({ path, method: "POST", authenticated: false })).not.toBeNull();
  }
  expect(denyReason({ path: "/api/threads/a/privacy/vault", method: "POST", authenticated: true })).not.toBeNull();
});

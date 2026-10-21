import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ChatDiagnostics, chatDeadline } from "./google-chat-diagnostics.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("keeps the last body result when poll history rolls over and across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-chat-diagnostics-")); dirs.push(dir);
  const diagnostics = new ChatDiagnostics(dir);
  const body = diagnostics.begin("body", "upstream"); diagnostics.stage(body, "parse"); diagnostics.stage(body, "mask"); diagnostics.end(body);
  for (let n = 0; n < 90; n++) { const poll = diagnostics.begin("poll", "feed"); diagnostics.end(poll); }
  expect(diagnostics.snapshot().recent).toHaveLength(64);
  expect(diagnostics.snapshot().body).toMatchObject({ id: body, code: "OK" });
  const restarted = new ChatDiagnostics(dir);
  expect(restarted.snapshot().body).toMatchObject({ id: body, code: "OK" });
  expect(restarted.snapshot().body?.steps.map(step => step.stage)).toEqual(["upstream", "parse", "mask"]);
  expect(readFileSync(join(dir, "google-chat-diagnostics.json"), "utf8").length).toBeLessThan(262144);
});
it("bounds a stalled asynchronous operation and gives cancellation a separate code", async () => {
  await expect(chatDeadline(10, undefined, () => new Promise(() => {}), "MASK_TIMEOUT")).rejects.toMatchObject({ code: "MASK_TIMEOUT" });
  const controller = new AbortController(); controller.abort();
  await expect(chatDeadline(1000, controller.signal, () => new Promise(() => {}), "MASK_TIMEOUT")).rejects.toMatchObject({ code: "CANCELLED" });
});

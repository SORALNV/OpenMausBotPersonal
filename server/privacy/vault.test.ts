import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PrivacyVault } from "./vault.ts";
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "omb-mapping-")); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it("keeps old model-generated tokens restorable only in scopes that already observed them", () => {
  const dir = directory();
  writeFileSync(join(dir, "vault.json"), JSON.stringify([{ scope: "old", text: "legacy@example.invalid", label: "private_email", token: "⟦メール_001⟧" }]), { mode: 0o600 });
  const vault = new PrivacyVault(dir);
  expect(vault.restoreForDisplay("old", "⟦メール_001⟧")).toBe("legacy@example.invalid");
  expect(vault.restoreForDisplay("other", "⟦メール_001⟧")).toBe("⟦メール_001⟧");
});
it("preserves preferred restoration and prevents reusing another person's alias", () => {
  const dir = directory(); const vault = new PrivacyVault(dir);
  vault.registerAlias("a", "星野架空", "利用者", "架空さん"); vault.commit();
  const restarted = new PrivacyVault(dir);
  expect(restarted.restoreForDisplay("a", "⟦利用者⟧")).toBe("架空さん");
  expect(() => restarted.registerAlias("a", "青空虚構", "利用者")).toThrow();
  expect(JSON.parse(readFileSync(join(dir, "vault.json"), "utf8"))).toHaveLength(1);
});

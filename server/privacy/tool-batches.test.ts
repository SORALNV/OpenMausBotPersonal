import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PersonalPrivacyService } from "./service.ts";
import { PrivacySettingsStore } from "./settings.ts";
import { DEFAULT_PERSONAL_PRIVACY } from "../../shared/personal-privacy.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it("keeps structured Google Chat results and their JSON mirrors consistent when a replacement contains quotes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-word-results-")); dirs.push(dir);
  new PrivacySettingsStore(dir).save({ ...DEFAULT_PERSONAL_PRIVACY, aliases: [{ replacement: '利用者"A', variants: ["星野架空"] }] });
  const service = new PersonalPrivacyService(dir, () => null);
  const result = { messages: Array.from({ length: 47 }, (_, i) => ({ sender: "星野架空", text: `星野架空からの架空メッセージ${i}`, email: "unknown@example.invalid" })) };
  const output = await service.filterToolResult("a", { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } }) as any;
  expect(output.structuredContent.result.messages).toHaveLength(47);
  expect(JSON.parse(output.content[0].text)).toEqual(output.structuredContent.result);
  expect(output.content[0].text).not.toContain("星野架空");
  expect(output.structuredContent.result.messages[0].email).toBe("unknown@example.invalid");
});
it("handles many literal strings without model inference and respects cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-word-results-")); dirs.push(dir);
  new PrivacySettingsStore(dir).save({ ...DEFAULT_PERSONAL_PRIVACY, aliases: [{ replacement: "利用者", variants: ["星野架空"] }] });
  const service = new PersonalPrivacyService(dir, () => null);
  expect(await service.filterToolResult("a", Array(600).fill("星野架空"))).toEqual(Array(600).fill("⟦利用者⟧"));
  const controller = new AbortController(); controller.abort();
  await expect(service.filterToolResult("a", "星野架空", controller.signal)).rejects.toThrow();
});

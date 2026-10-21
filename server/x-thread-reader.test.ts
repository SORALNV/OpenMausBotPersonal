import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadBundledSkills, loadUserSkills, mergeSkills, renderSkillInstructions, selectBundledSkills } from "./skill-library.ts";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("X URL automatic skill routing", () => {
  const root = join(process.cwd(), "skills");
  const skills = loadBundledSkills(root);

  it("mounts the reader for pasted X and Twitter URLs without a slash command", () => {
    for (const text of ["https://x.com/alice/status/100?s=46", "https://twitter.com/alice/status/100", "読んで https://www.x.com/alice/status/100"]) {
      const selected = selectBundledSkills(text, [], skills);
      expect(selected.map(s => s.manifest.id)).toContain("x-thread-reader");
      expect(renderSkillInstructions(selected)).toContain("@use_ai84242");
    }
    expect(selectBundledSkills("普通のチャットです", [], skills).map(s => s.manifest.id)).not.toContain("x-thread-reader");
  });

  it("can hot-load the same reader through the production user-skill loader", () => {
    const temporary = mkdtempSync(join(tmpdir(), "omb-x-skill-"));
    try {
      cpSync(join(root, "x-thread-reader"), join(temporary, "x-thread-reader"), { recursive: true });
      const user = loadUserSkills(temporary);
      expect(selectBundledSkills("https://x.com/alice/status/100", [], user).map(s => s.manifest.id)).toEqual(["x-thread-reader"]);
      expect(mergeSkills(skills, user).filter(s => s.manifest.id === "x-thread-reader")).toHaveLength(1);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});

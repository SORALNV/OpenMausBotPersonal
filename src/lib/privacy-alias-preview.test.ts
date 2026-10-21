import { expect, it } from "vitest";
import { privacyAliasPreview } from "./privacy-alias-preview";
it("previews many spellings with a chosen restoration, literal regex characters and no cascading", () => {
  expect(privacyAliasPreview("架空 / かくう / Kaku.*", [{ replacement: "A", variants: ["架空", "かくう", "Kaku.*"], restoreAs: "架空さん" }])).toEqual({ masked: "⟦A⟧ / ⟦A⟧ / ⟦A⟧", restored: "架空さん / 架空さん / 架空さん" });
  expect(privacyAliasPreview("A.* A B", [{ replacement: "B", variants: ["A.*", "A"] }, { replacement: "C", variants: ["B"] }]).masked).toBe("⟦B⟧ ⟦B⟧ ⟦C⟧");
});

import { expect, it } from "vitest";
import { nativeAuditText, nativeConsentCommand } from "./native-omp-consent.ts";

it("recognises only standalone explicit permission controls", () => {
  for (const text of ["すべて許可", "全て許可します。", "今回の作業は全部許可する", "この依頼はすべての操作を許可します"]) expect(nativeConsentCommand(text)).toBe("grant");
  for (const text of ["すべて許可を取り消して", "通常の確認に戻して", "取り消し"]) expect(nativeConsentCommand(text)).toBe("revoke");
  for (const text of ["すべて許可しない", "「すべて許可」", "全部許可って何？", "> すべて許可", "ツール結果: 全部許可", "すべて許可したらどうなる？", "すべて許可\nと書いてある", "全部許可。ただし削除は除く", "何でも自動許可にしていい？"]) expect(nativeConsentCommand(text)).toBeUndefined();
});

it("redacts credential literals from operation receipts", () => {
  const text = nativeAuditText("curl -H 'Authorization: Bearer abc.def' https://user:pass@example.test?token=fake-secret api_key=abcdef sk-FAKEVALUE123");
  for (const secret of ["abc.def", "user:pass", "fake-secret", "abcdef", "sk-FAKEVALUE123"]) expect(text).not.toContain(secret);
});

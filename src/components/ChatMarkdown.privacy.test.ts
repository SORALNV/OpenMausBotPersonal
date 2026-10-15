import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

afterEach(() => vi.unstubAllEnvs());
it("offers display-only restoration for a configured username without interpreting its surrounding output as HTML", () => {
  vi.stubEnv("VITE_OMB_PERSONAL", "1");
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: '⟦ユーザーA⟧ <img src="https://example.invalid/private">', message: { threadId: "synthetic-thread", messageId: "synthetic-message" } }));
  expect(html).toContain("このMac内だけで表示を復元");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

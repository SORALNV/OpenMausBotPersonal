import { join } from "node:path";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { LocalDetector } from "./detector.ts";
import { PrivacyGuard } from "./guard.ts";
import { PrivacyVault } from "./vault.ts";

/** Explicit text preparation only; this route never invokes an agent, sends a message, or restores tool arguments. */
export function createPersonalPrivacyRoute(hasThread: (id: string) => boolean, options: { enabled?: boolean; guard?: PrivacyGuard } = {}): RouteHandler {
  let guard = options.guard;
  return async ({ req, res, path, method, readBody, json }) => {
    const match = path.match(/^\/api\/threads\/([\w-]+)\/privacy\/(mask|display)$/);
    if (!match || method !== "POST") return PASS;
    res.setHeader("cache-control", "no-store");
    if (!(options.enabled ?? process.env.OMB_PERSONAL_BUILD === "1")) return json(res, 404, { error: "仮名化機能はこのサーバーでは有効ではありません。" });
    if (!hasThread(match[1])) return json(res, 404, { error: "会話が見つかりません。" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON が必要です。" });
    const body = await readBody(req, 256 * 1024);
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 100_000) return json(res, 400, { error: "本文は1〜100,000文字で入力してください。" });
    const names: unknown = body.names ?? [];
    if (!Array.isArray(names) || names.length > 50 || names.some(name => typeof name !== "string" || !name.trim() || name.length > 100)) return json(res, 400, { error: "保護する氏名は1件100文字以内・50件以内で指定してください。" });
    try {
      if (!guard) {
        guard = new PrivacyGuard(new PrivacyVault(join(process.env.OMB_DATA_DIR!, "private")), new LocalDetector());
        process.once("exit", () => guard?.close());
      }
      const text = match[2] === "mask" ? await guard.protect(match[1], body.text, undefined, names.map(text => ({ text: text as string, label: "private_person" as const }))) : guard.vault.restoreForDisplay(match[1], body.text);
      return json(res, 200, { text });
    } catch {
      return json(res, 503, { error: "Mac内の仮名化・復元に失敗しました。原文はAIへ送信していません。" });
    }
  };
}

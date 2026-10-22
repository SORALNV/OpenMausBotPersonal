import { PASS, type RouteHandler } from "../routes/table.ts";
import type { PersonalPrivacyService } from "./service.ts";

/** Explicit text preparation only; this route never invokes an agent, sends a message, or restores tool arguments. */
export function createPersonalPrivacyRoute(hasThread: (id: string) => boolean, options: { enabled?: boolean; service: PersonalPrivacyService }): RouteHandler {
  return async (ctx) => {
    if (await options.service.settingsRoute(ctx) !== PASS) return;
    const { req, res, path, method, readBody, json } = ctx;
    const match = path.match(/^\/api\/threads\/([\w-]+)\/privacy\/(mask|display)$/);
    if (!match || method !== "POST") return PASS;
    res.setHeader("cache-control", "no-store");
    if (!(options.enabled ?? process.env.OMB_PERSONAL_BUILD === "1")) return json(res, 404, { error: "仮名化機能はこのサーバーでは有効ではありません。" });
    if (!hasThread(match[1])) return json(res, 404, { error: "会話が見つかりません。" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON が必要です。" });
    const body = await readBody(req, 256 * 1024);
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 100_000) return json(res, 400, { error: "本文は1〜100,000文字で入力してください。" });
    if (body.names !== undefined && (!Array.isArray(body.names) || body.names.length)) return json(res, 400, { error: "追加の語句は設定の置換ルールに登録してください。" });
    try {
      const text = match[2] === "mask" ? await options.service.mask(match[1], body.text) : options.service.display(match[1], body.text);
      return json(res, 200, { text });
    } catch {
      return json(res, 503, { error: "登録語句の置換・復元に失敗しました。原文はAIへ送信していません。" });
    }
  };
}

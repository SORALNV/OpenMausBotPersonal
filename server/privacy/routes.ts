import { PASS, type RouteHandler } from "../routes/table.ts";
import { restorePrivacyDisplay } from "./boundary.ts";
import { privacyStrict } from "./policy.ts";

export const privacyDisplayRoute: RouteHandler = async ({ req, res, path, method, auth, readBody, json }) => {
  if (path === "/api/privacy/status" && method === "GET") {
    res.setHeader("cache-control", "no-store");
    const token = process.env.OMB_PRIVACY_APP_TOKEN;
    if (!privacyStrict() || auth.kind !== "loopback" || !token || req.headers["x-omb-privacy-instance"] !== token) return json(res, 403, { error: "保護版アプリの起動確認専用です。" });
    res.setHeader("X-OMB-Privacy-Instance", token);
    return json(res, 200, { mode: "strict", device: process.env.OMB_PRIVACY_DEVICE, ready: true });
  }
  if (path !== "/api/privacy/display" || method !== "POST") return PASS;
  res.setHeader("cache-control", "no-store");
  if (!privacyStrict() || auth.kind !== "loopback") return json(res, 403, { error: "ローカル表示専用です。" });
  const body = await readBody(req, 256 * 1024);
  if (typeof body?.threadId !== "string" || typeof body?.text !== "string" || body.text.length > 100_000) return json(res, 400, { error: "表示対象が不正です。" });
  return json(res, 200, { text: restorePrivacyDisplay(body.threadId, body.text) });
};

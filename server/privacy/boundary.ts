import { join, resolve } from "node:path";
import { LocalDetector } from "./detector.ts";
import { PrivacyGuard } from "./guard.ts";
import { PrivacyVault } from "./vault.ts";
import { PrivacyBlocked, privacyStrict } from "./policy.ts";

let transport: typeof fetch | undefined;
let guard: PrivacyGuard | undefined;

export function installPrivacyBoundary(localGuard?: PrivacyGuard): () => void {
  if (transport) throw new PrivacyBlocked("保護層は既に起動しています。");
  transport = globalThis.fetch;
  guard = localGuard ?? new PrivacyGuard(new PrivacyVault(join(process.env.OMB_DATA_DIR!, "private")), new LocalDetector());
  globalThis.fetch = async () => { throw new PrivacyBlocked("厳格モード: 未保護の HTTP 送信は無効です。"); };
  return () => {
    guard?.close();
    if (transport) globalThis.fetch = transport;
    transport = undefined;
    guard = undefined;
  };
}

export function assertPrivacyStartup(dataDir: string): void {
  if (!privacyStrict()) return;
  if (!transport || !guard || !process.env.OMB_PRIVACY_DEV_ROOT || !resolve(dataDir).startsWith(resolve(process.env.OMB_PRIVACY_DEV_ROOT) + "/")) {
    throw new PrivacyBlocked("保護版は pnpm privacy:dev で独立したデータ領域に起動してください。");
  }
}

export async function protectedChatFetch(url: string, init: RequestInit, scope: string): Promise<Response> {
  if (!privacyStrict()) return fetch(url, init);
  if (!transport || !guard) throw new PrivacyBlocked("ローカル保護層が起動していません。");
  const endpoint = new URL(url);
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/chat/completions")) throw new PrivacyBlocked("保護対象外の送信先です。");
  let payload: unknown;
  try { payload = JSON.parse(String(init.body)); } catch { throw new PrivacyBlocked("テキスト JSON 以外は送信できません。"); }
  const authorization = new Headers(init.headers).get("authorization")?.replace(/^Bearer\s+/i, "");
  const protectedPayload = await guard.protect(scope, payload, init.signal ?? undefined,
    authorization ? [{ text: authorization, label: "secret" }] : []);
  const response = await transport(url, { ...init, redirect: "error", body: JSON.stringify(protectedPayload) });
  if (!response.ok) {
    await response.body?.cancel();
    return new Response('{"error":{"message":"Protected provider request failed"}}', { status: response.status });
  }
  return response;
}

/** The restored value is available exclusively to the local, explicit display route. */
export function restorePrivacyDisplay(scope: string, text: string): string {
  if (!privacyStrict() || !guard) throw new PrivacyBlocked();
  return guard.vault.restoreForDisplay(scope, text);
}

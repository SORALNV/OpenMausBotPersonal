import type { IncomingMessage, Server } from "node:http";

export class PrivacyBlocked extends Error {
  constructor(reason = "ローカル保護層で送信を停止しました。") {
    super(reason);
    this.name = "PrivacyBlocked";
  }
}

export function privacyStrict(): boolean {
  const mode = process.env.OMB_PRIVACY_MODE ?? "off";
  if (mode !== "strict" && mode !== "off") throw new PrivacyBlocked("保護モードの設定が不正です。");
  return mode === "strict";
}

export const PROTECTED_DRIVERS = new Set(["openai-compat", "grok", "minimax", "mistral", "cerebras", "groq", "meta"]);

export function privacyDriverRefusal(driver: string): string | undefined {
  return privacyStrict() && !PROTECTED_DRIVERS.has(driver)
    ? "厳格モード: この接続方式の独自送信・ファイル読取は保護できないため無効です。"
    : undefined;
}

export function protectPrivacySockets(server: Server): boolean {
  if (!privacyStrict()) return false;
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  return true;
}

const READ_ROUTES = /^\/api\/(?:health|auth\/session|brand|config|events|bots|threads|providers|instances|models|sections|teams|channels|onboarding)(?:\/|$)/;
const WRITE_ROUTES = /^\/api\/(?:bots(?:\/[\w-]+(?:\/(?:tasks|messages|interrupt|model))?)?|threads\/[\w-]+\/(?:send|interrupt|steer|messages)|privacy\/display)$/;

export function privacyRequestBlocked(req: IncomingMessage, url: URL): boolean {
  if (!privacyStrict()) return false;
  const local = req.socket.remoteAddress;
  if (local !== "127.0.0.1" && local !== "::1" && local !== "::ffff:127.0.0.1") return true;
  if (req.headers.forwarded || req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]) return true;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${process.env.OMB_UI_PORT}` && origin !== `http://127.0.0.1:${process.env.OMB_PORT}`) return true;
  if (!url.pathname.startsWith("/api/")) return !["GET", "HEAD"].includes(req.method ?? "GET");
  if (req.method === "GET") {
    if (url.pathname === "/api/privacy/status") return false;
    // Nested service endpoints can start a browser, a provider login, or a remote connection even on GET.
    return !READ_ROUTES.test(url.pathname) || /(?:computer|browser|authenticat|login|connect|attachments|files|export|mcp|voice|call|data|native)/i.test(url.pathname);
  }
  return !WRITE_ROUTES.test(url.pathname) || !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""));
}

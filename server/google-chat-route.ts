import { PASS, type RouteHandler } from "./routes/table.ts";

/** A separately packaged Google Chat module can own a different route sentinel; decline unrelated paths in the host's router. */
export function scopeGoogleChatRoute(handler: RouteHandler): RouteHandler {
  return context => {
    if (!["/api/google-chat", "/api/google-chat/connect", "/api/google-chat/check"].includes(context.path) || !["GET", "PUT", "POST"].includes(context.method)) return Promise.resolve(PASS);
    return handler(context);
  };
}

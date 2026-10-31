import { expect, it, vi } from "vitest";
import { scopeGoogleChatRoute } from "./google-chat-route.ts";
import { dispatchRoutes, PASS, type RouteContext } from "./routes/table.ts";
it("a foreign module's sentinel cannot swallow auth/session or unrelated API reads", async () => {
  const moduleRoute = vi.fn(async () => Symbol("route.pass"));
  const handler = scopeGoogleChatRoute(moduleRoute as any);
  const context = { path: "/api/auth/session", method: "GET", res: { headersSent: false, writableEnded: false } } as RouteContext;
  expect(await dispatchRoutes([handler], context)).toBe(false); expect(moduleRoute).not.toHaveBeenCalled();
});
it("preserves the module's answer and authorization checks for its own routes", async () => {
  const answer = vi.fn(async () => undefined); const handler = scopeGoogleChatRoute(answer);
  expect(await handler({ path: "/api/google-chat/check", method: "POST" } as RouteContext)).toBeUndefined();expect(answer).toHaveBeenCalledOnce();
  expect(await handler({ path: "/api/google-chat/check", method: "DELETE" } as RouteContext)).toBe(PASS);
});

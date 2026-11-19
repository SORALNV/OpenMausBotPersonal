import { PASS } from "./table.ts";

export async function personalInternalRoutes(method: string, path: string, handlers: {
  manageMcp: () => Promise<void>;
  delegatedMcp: (name: string) => Promise<void>;
  nativeConnect: () => Promise<void>;
}): Promise<void | typeof PASS> {
  if (method !== "POST") return PASS;
  if (path === "/api/internal/mcp-access") return handlers.manageMcp();
  const delegated = path.match(/^\/api\/internal\/delegated-mcp\/([a-z][a-z0-9_-]{0,31})$/u);
  if (delegated) return handlers.delegatedMcp(delegated[1]!);
  if (path === "/api/internal/native-connect") return handlers.nativeConnect();
  return PASS;
}

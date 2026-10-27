import { accessRuleInput, type McpAccess } from "../mcp-access.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import { parseStoredMcpServer } from "../mcp-registry.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function mcpAccessRoutes(input: { access: McpAccess; servers: () => Record<string, unknown>; signed: (name: string, server: any) => Promise<any>; sessionLive: (id: string) => boolean }): RouteHandler {
  return async ({ path, method, auth, req, res, readBody, json }) => {
    if (path !== "/api/mcp/access" && !path.startsWith("/api/mcp/access/")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "本人の管理権限が必要です。" });
    res.setHeader("Cache-Control", "no-store");
    if (method === "GET" && path === "/api/mcp/access") return json(res, 200, input.access.view());
    const match = path.match(/^\/api\/mcp\/access\/([a-z][a-z0-9_-]{0,31})(\/catalog)?$/u);
    if (!match) return json(res, 404, { error: "設定先が見つかりません。" });
    const server = match[1]!;
    if (method === "DELETE" && !match[2]) { input.access.revokePolicy(server); return json(res, 200, input.access.view()); }
    if ((method === "GET" && match[2]) || (method === "PUT" && !match[2])) {
      const body = method === "PUT" ? await readBody(req, 100_000) : undefined;
      if (body && body.server !== undefined) return json(res, 400, { error: "サーバー名はURLで指定してください。" });
      const revision = input.access.revision(server), parsed = parseStoredMcpServer(server, input.servers()[server]);
      if (!parsed.ok) return json(res, 400, { error: "登録されたMCPの設定が不正です。" });
      const result = await probeMcpServer(await input.signed(server, parsed.server), 15000);
      if (!result.ok) return json(res, 502, { error: result.error });
      if (input.access.revision(server) !== revision) return json(res, 409, { error: "確認中にMCPの接続設定が変わりました。再確認してください。" });
      if (method === "GET") { const saved = input.access.view(); return json(res, 200, { tools: result.tools, revision, policyRevision: input.access.policyRevision(server), rule: saved.rules[server], audit: saved.audit.filter(a => a.server === server) }); }
      if (auth.kind === "session" && !input.sessionLive(auth.session.id)) return json(res, 401, { error: "認証が終了しました。" });
      if (body.revision !== revision) return json(res, 409, { error: "接続設定が変わりました。ツール一覧を確認し直してください。" });
      if (body.policyRevision !== input.access.policyRevision(server)) return json(res, 409, { error: "別の権限変更が反映されています。再読込して確認してください。" });
      const { revision: _revision, policyRevision: _policyRevision, ...settings } = body;
      const checked = accessRuleInput.safeParse({ ...settings, server });
      if (!checked.success) return json(res, 400, { error: "委任する管理者・対象Bot・ツールの設定が不正です。" });
      input.access.configure(checked.data, result.tools.map(t => t.name));
      return json(res, 200, { ...input.access.view(), policyRevision: input.access.policyRevision(server) });
    }
    return json(res, 405, { error: "対応していない操作です。" });
  };
}

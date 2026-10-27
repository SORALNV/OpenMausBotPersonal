import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const remote = vi.hoisted(() => ({ initialize: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock("./mcp-http.ts", () => ({ RemoteMcpClient: class { initialize = remote.initialize; request = remote.request; close = remote.close; } }));
import { McpAccess } from "./mcp-access.ts";
const dirs: string[] = [];
beforeEach(() => { remote.initialize.mockReset().mockResolvedValue({}); remote.request.mockReset(); remote.close.mockReset().mockResolvedValue(undefined); });
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-mcp-access-")); dirs.push(dir);
  const bots: Record<string, any> = { manager: { id: "manager", name: "Manager" }, reporter: { id: "reporter", name: "記者" }, other: { id: "other", name: "他" } };
  const servers: Record<string, any> = { home: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer synthetic-secret-never-print" }, enabled: false } };
  const input = { file: join(dir, "access.json"), servers: () => servers, bot: (id: string) => bots[id], refusal: () => undefined };
  const access = new McpAccess(input), policy = { server: "home", managers: ["manager"], targets: ["reporter", "other"], tools: ["list", "read"], grants: [{ botId: "reporter", tools: ["list", "read"] }] };
  access.configure(policy, ["list", "read", "write"]);
  return { access, input, policy, bots, servers };
}
const frame = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });
it("mounts a disabled shared server for only the explicitly granted bot", () => {
  const f = fixture(); expect(f.servers.home.enabled).toBe(false); expect(f.access.mounted("reporter")).toEqual(["home"]); expect(f.access.mounted("other")).toEqual([]); expect(f.access.mounted("manager")).toEqual([]);
});
it("allows an authorized manager to narrow, grant, list and revoke within the owner ceiling", () => {
  const f = fixture(); f.access.manage("manager", { action: "set", server: "home", targetId: "other", tools: ["list"], reason: "一覧確認の担当" });
  expect(f.access.permitted("other", "home", "list")).toBe(true); expect(f.access.permitted("other", "home", "read")).toBe(false);
  expect((f.access.manage("manager", { action: "list" }) as any).servers).toHaveLength(1);
  f.access.manage("manager", { action: "revoke", server: "home", targetId: "other", reason: "担当終了" }); expect(f.access.mounted("other")).toEqual([]);
  expect(f.access.view().audit.at(-1)?.actor).toBe("manager");
});
it.each([
  ["other", { action: "set", server: "home", targetId: "reporter", tools: ["list"], reason: "なりすまし" }],
  ["manager", { action: "set", server: "home", targetId: "manager", tools: ["list"], reason: "自己昇格" }],
  ["manager", { action: "set", server: "home", targetId: "reporter", tools: ["write"], reason: "上限外" }],
  ["manager", { action: "set", server: "home", targetId: "reporter", tools: ["*"], reason: "ワイルドカード" }],
  ["manager", { action: "set", server: "home", targetId: "reporter", tools: ["list"], reason: "管理者変更", managers: ["other"] }],
])("rejects unauthorized delegation without changing the saved policy (%s)", (actor, body) => {
  const f = fixture(), before = readFileSync(f.input.file, "utf8"); expect(() => f.access.manage(actor as string, body)).toThrow(); expect(readFileSync(f.input.file, "utf8")).toBe(before);
});
it("intersects the owner bot's own selection with the delegated grant", () => { const f = fixture(); f.bots.reporter.toolScope = { deny: ["mcp:home:read"] }; expect(f.access.permitted("reporter", "home", "read")).toBe(false); expect(f.access.permitted("reporter", "home", "list")).toBe(true); });
it.each(["url", "headers"])("invalidates delegation when the registered %s changes", key => {
  const f = fixture(); f.servers.home[key] = key === "url" ? "http://127.0.0.1:2/mcp" : { Authorization: "changed-synthetic-secret" }; expect(f.access.mounted("reporter")).toEqual([]); expect(f.access.owns("home")).toBe(true); expect(() => f.access.manage("manager", { action: "revoke", server: "home", targetId: "reporter", reason: "変更" })).toThrow();
});
it("keeps a revoked rule as a tombstone so shared enabled defaults cannot restore access", () => { const f = fixture(); f.servers.home.enabled = true; f.access.revokePolicy("home"); expect(f.access.owns("home")).toBe(true); expect(f.access.mounted("reporter")).toEqual([]); });
it("persists private grants and receipts across a restart without storing upstream credentials", () => { const f = fixture(); expect(statSync(f.input.file).mode & 0o077).toBe(0); expect(readFileSync(f.input.file, "utf8")).not.toContain("synthetic-secret"); const again = new McpAccess(f.input); expect(again.mounted("reporter")).toEqual(["home"]); });
it("fails closed on corrupt saved policy and unknown tools", () => { const f = fixture(); expect(() => f.access.configure({ ...f.policy, tools: ["unknown"] }, ["list"])).toThrow(); writeFileSync(f.input.file, '{"version":1,"rules":false,"audit":[]}'); expect(() => new McpAccess(f.input)).toThrow(); });
it("lists only permitted tools and removes echoed credentials from the reply", async () => {
  const f = fixture(); remote.request.mockResolvedValue({ tools: [{ name: "list", description: "Bearer synthetic-secret-never-print" }, { name: "read" }, { name: "write" }] });
  const answer = await f.access.rpc("reporter", "home", frame("tools/list"), new AbortController().signal);
  expect(answer.result.tools.map((t: any) => t.name)).toEqual(["list", "read"]); expect(JSON.stringify(answer)).not.toContain("synthetic-secret");
});
it("permits an exact approved call and blocks writes before opening an upstream session", async () => {
  const f = fixture(); remote.request.mockResolvedValue({ content: [{ type: "text", text: "架空の一覧" }] });
  await f.access.rpc("reporter", "home", frame("tools/call", { name: "list", arguments: { path: "/fixture" } }), new AbortController().signal);
  expect(remote.request).toHaveBeenCalledWith("tools/call", { name: "list", arguments: { path: "/fixture" } }, expect.any(AbortSignal));
  remote.initialize.mockClear(); await expect(f.access.rpc("reporter", "home", frame("tools/call", { name: "write" }), new AbortController().signal)).rejects.toThrow(); expect(remote.initialize).not.toHaveBeenCalled();
});
it.each(["resources/read", "prompts/get", "tasks/get", "tools/call"])("blocks ungranted clients and alternate protocol access: %s", async method => { const f = fixture(); await expect(f.access.rpc("other", "home", frame(method), new AbortController().signal)).rejects.toThrow(); expect(remote.initialize).not.toHaveBeenCalled(); });
it("rechecks a grant after slow upstream initialization so revocation is immediate", async () => {
  const f = fixture(); remote.initialize.mockImplementation(async () => { f.access.manage("manager", { action: "revoke", server: "home", targetId: "reporter", reason: "担当終了" }); });
  await expect(f.access.rpc("reporter", "home", frame("tools/call", { name: "list" }), new AbortController().signal)).rejects.toThrow(); expect(remote.request).not.toHaveBeenCalled(); expect(remote.close).toHaveBeenCalledOnce();
});
it("does not reveal upstream error bodies, tokens or server-side settings to the model", async () => { const f = fixture(); remote.request.mockRejectedValue(Error("Bearer synthetic-secret-never-print")); await expect(f.access.rpc("reporter", "home", frame("tools/list"), new AbortController().signal)).rejects.toThrow("MCPの呼び出しを完了できません"); });
it("rejects a previously admitted request when its source turn expires during initialization", async () => {
  const f = fixture(); let active = true; remote.initialize.mockImplementation(async () => { active = false; });
  await expect(f.access.rpc("reporter", "home", frame("tools/call", { name: "list" }), new AbortController().signal, undefined, () => active)).rejects.toMatchObject({ status: 401 });
  expect(remote.request).not.toHaveBeenCalled();
});
it("has a policy revision that changes when a manager updates a grant", () => { const f = fixture(), before = f.access.policyRevision("home"); f.access.manage("manager", { action: "revoke", server: "home", targetId: "reporter", reason: "担当終了" }); expect(f.access.policyRevision("home")).not.toBe(before); });
it("never re-enables a server or tool excluded by the target bot's owner settings", () => {
  const f = fixture(); f.bots.reporter.mcpServers = [];
  expect(f.access.permitted("reporter", "home", "list")).toBe(false);
  expect(() => f.access.manage("manager", { action: "set", server: "home", targetId: "reporter", tools: ["list"], reason: "担当" })).toThrow();
  delete f.bots.reporter.mcpServers; f.bots.reporter.toolScope = { deny: ["mcp:home:read"] };
  expect(() => f.access.manage("manager", { action: "set", server: "home", targetId: "reporter", tools: ["read"], reason: "担当" })).toThrow();
});
it("informs only assigned managers of the usable delegation tool and owner ceiling", () => {
  const f = fixture(); expect(f.access.prompt("manager")).toContain("manage_mcp_access"); expect(f.access.prompt("manager")).toContain('"tools":["list","read"]'); expect(f.access.prompt("manager")).not.toContain("synthetic-secret"); expect(f.access.prompt("reporter")).toBe("");
});
it("does not resurrect grants after a registered address is changed and restored or removed", () => {
  const f = fixture(), original = structuredClone(f.servers.home);
  f.access.beforeServersChange({ home: { ...original, url: "http://127.0.0.1:2/mcp" } });
  f.servers.home = original; expect(f.access.mounted("reporter")).toEqual([]); expect((f.access.manage("manager", { action: "list" }) as any).servers).toEqual([]);
  f.access.configure(f.policy, ["list", "read"]); f.access.beforeServersChange({}); expect(f.access.mounted("reporter")).toEqual([]);
});

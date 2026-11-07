// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), state: { bots: [{ id: "manager", name: "Manager" }, { id: "reporter", name: "記者" }, { id: "other", name: "他Bot" }] } }));
vi.mock("@/state/store", () => ({ api: mocks.api, useStore: () => ({ state: mocks.state }) }));
import { McpAccessPanel } from "./McpAccessPanel";
let root: Root, div: HTMLDivElement, policy: any;
beforeEach(() => {
  div = document.createElement("div"); document.body.append(div); root = createRoot(div); policy = { version: 1, rules: {}, audit: [] };
  mocks.api.mockReset().mockImplementation(async (path: string, opts?: RequestInit) => {
    if (path.endsWith("/catalog")) return { revision: "fixture-revision", policyRevision: "fixture-policy", rule: policy.rules.home, audit: policy.audit, tools: [{ name: "nas_list", description: "一覧" }, { name: "nas_read_text", description: "読取" }, { name: "nas_write_text", description: "書込" }] };
    if (opts?.method === "PUT") return { ...policy, audit: [{ at: 0, server: "home", actor: "owner", target: "policy", tools: [], reason: "設定" }] };
    return policy;
  });
});
afterEach(async () => { await act(async () => root.unmount()); div.remove(); });
const click = async (label: string) => { const node = [...div.querySelectorAll<HTMLElement>("button,input")].find(n => n.getAttribute("aria-label") === label || n.textContent === label); expect(node, label).toBeTruthy(); await act(async () => node!.click()); };
const open = async () => { await act(async () => root.render(createElement(McpAccessPanel, { server: "home" }))); await click("home のBot別権限・Managerへの委任"); };
it("does not grant a target tools implicitly when the owner only selects an eligible bot", async () => {
  await open(); await click("上限: nas_list"); await click("管理者: Manager"); await click("対象: 記者"); await click("home の委任・初期権限を保存");
  const call = mocks.api.mock.calls.find(([,opts]) => opts?.method === "PUT")!; const body = JSON.parse(call[1]!.body as string);
  expect(body).toMatchObject({ managers: ["manager"], targets: ["reporter"], tools: ["nas_list"], grants: [] }); expect(div.textContent).toContain("Bot別の権限設定を保存しました");
});
it("saves precisely selected read tools and initial reporter grant without enabling shared distribution", async () => {
  await open(); await click("上限: nas_list"); await click("上限: nas_read_text"); await click("管理者: Manager"); await click("対象: 記者"); await click("初期付与: 記者: nas_list"); await click("home の委任・初期権限を保存");
  const body = JSON.parse(mocks.api.mock.calls.find(([,opts]) => opts?.method === "PUT")![1]!.body as string);
  expect(body.tools).toEqual(["nas_list", "nas_read_text"]); expect(body.grants).toEqual([{ botId: "reporter", tools: ["nas_list"] }]); expect(JSON.stringify(body)).not.toContain("nas_write_text"); expect(mocks.api.mock.calls.some(([path]) => path.includes("/mcp/servers"))).toBe(false);
});
it("preserves an existing narrower grant when changing only the manager selection", async () => {
  policy.rules.home = { managers: ["manager"], targets: ["reporter"], tools: ["nas_list", "nas_read_text"], grants: { reporter: ["nas_list"] } };
  await open(); await click("管理者: 他Bot"); await click("home の委任・初期権限を保存");
  const body = JSON.parse(mocks.api.mock.calls.find(([,opts]) => opts?.method === "PUT")![1]!.body as string); expect(body.grants).toEqual([{ botId: "reporter", tools: ["nas_list"] }]);
});
it("surfaces a failed catalog probe and does not let a blank policy be saved", async () => {
  mocks.api.mockImplementation(async path => { if (path.endsWith("/catalog")) throw Error("接続できません"); return policy; }); await open(); expect(div.textContent).toContain("接続できません"); expect([...div.querySelectorAll("button")].find(b=>b.textContent === "home の委任・初期権限を保存")?.disabled).toBe(true);
});

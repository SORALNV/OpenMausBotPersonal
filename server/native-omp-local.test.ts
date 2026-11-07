import { expect, it } from "vitest";
import { nativeOmpLocalScope } from "./native-omp-local.ts";
import { allowsTool } from "../shared/tool-scope.ts";

it("allows OMB management tools but blocks native execution, remote MCP, and delegation", () => {
  const scope = nativeOmpLocalScope(undefined);
  expect(allowsTool(scope, { kind: "mcp", server: "agents", name: "list_triggers" })).toBe(true);
  for (const tool of [{ kind: "native" as const, name: "Bash" }, { kind: "mcp" as const, server: "wol", name: "wake" }, ...["vm_exec", "coordinate_bots", "start_thread", "select_computer", "shared_computer"].map(name => ({ kind: "mcp" as const, server: "agents", name }))]) expect(allowsTool(scope, tool)).toBe(false);
});

it("intersects with existing restrictions instead of widening access", () => {
  const scope = nativeOmpLocalScope({ allow: ["mcp:agents:list_bots", "mcp:agents:list_triggers"], deny: ["mcp:agents:list_triggers"] });
  expect(scope.allow).toEqual(["mcp:agents:list_bots"]);
});

import { vi } from "vitest";
import { runNativeOmpLocal } from "./native-omp-local.ts";
const binding = { botId: "fixture", enabled: true, host: "fixture.invalid", user: "fixture", binary: "/fixture/omp", stateRoot: "/fixture", profile: "fixture", cwd: "/fixture", model: "fixture", mediator: { providerId: "fixture", modelId: "small", timeoutMs: 1000 } };

it("executes only catalogued OMB calls and deduplicates reordered arguments", async () => {
  const generate = vi.fn().mockResolvedValueOnce(JSON.stringify({ tool: "list_triggers", arguments: { b: 2, a: 1 } })).mockResolvedValueOnce(JSON.stringify({ arguments: { a: 1, b: 2 }, tool: "list_triggers" })).mockResolvedValueOnce(JSON.stringify({ answer: "確認しました。" }));
  const call = vi.fn(async () => ({ text: "架空の一覧" }));
  expect(await runNativeOmpLocal({ binding, request: "設定を見せて", signal: new AbortController().signal, tools: [{ name: "list_triggers" }], generate, call })).toBe("確認しました。");
  expect(call).toHaveBeenCalledOnce(); expect(generate.mock.calls.at(-1)?.[2]).toContain("架空の一覧");
});

it("rejects native, remote, executable-registration and delegation calls even if present in the catalog", async () => {
  for (const name of ["bash", "vm_exec", "coordinate_bots", "add_mcp_server", "skill_manage"]) {
    const call = vi.fn(async () => ({ text: "never" }));
    await expect(runNativeOmpLocal({ binding, request: "OMBを設定して", signal: new AbortController().signal, tools: [{ name }], generate: async () => JSON.stringify({ tool: name, arguments: {} }), call })).rejects.toThrow("許可されたOMB");
    expect(call).not.toHaveBeenCalled();
  }
});

it("Stop cancels a model that ignores its signal before any call", async () => {
  const controller = new AbortController(), call = vi.fn(async () => ({ text: "never" }));
  const pending = runNativeOmpLocal({ binding, request: "設定を確認", signal: controller.signal, tools: [{ name: "list_triggers" }], generate: () => new Promise(() => {}), call });
  controller.abort(); await expect(pending).rejects.toThrow("停止"); expect(call).not.toHaveBeenCalled();
});

import { expect, it } from "vitest";
import { PRIVACY_TOOL_OPTION as option, privacyToolCatalog, privacyToolRequest } from "./tool-option.ts";
it("offers masked retrieval as a schema capability without changing the upstream tool name or required fields", () => {
  const original = { tools: [{ name: "get_messages", inputSchema: { type: "object", properties: { space: { type: "string" } }, required: ["space"], additionalProperties: false } }] };
  const changed = privacyToolCatalog(original) as typeof original;
  expect(changed.tools[0].name).toBe("get_messages");
  expect(changed.tools[0].inputSchema.required).toEqual(["space"]);
  expect(changed.tools[0].inputSchema.properties).toHaveProperty(option);
  expect(original.tools[0].inputSchema.properties).not.toHaveProperty(option);
});
it("consumes the opt-in locally, preserves original arguments, and rejects ambiguous values", () => {
  const frame = { jsonrpc: "2.0", id: "read", method: "tools/call", params: { name: "get_messages", arguments: { space: "synthetic", [option]: true } } };
  const request = privacyToolRequest(frame);
  expect(request.model).toBe(true); expect(request.frame.params.arguments).toEqual({ space: "synthetic" });
  expect(privacyToolRequest({ ...frame, params: { ...frame.params, arguments: {} } }).model).toBe(false);
  expect(() => privacyToolRequest({ ...frame, params: { ...frame.params, arguments: { [option]: "yes" } } })).toThrow();
});

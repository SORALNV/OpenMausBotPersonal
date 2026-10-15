import { expect, it } from "vitest";
import { privacyPorts } from "./privacy-ports.mjs";

it.each(["0", "abc", "08799", " 5199", "8799", "8800", "5199", "65536"])("rejects ports that could fall back or point at production: %s", port => {
  expect(() => privacyPorts({ OMB_PRIVACY_UI_PORT: port })).toThrow();
});
it("uses distinct isolated ports", () => {
  expect(privacyPorts({})).toEqual({ OMB_PORT: "8899", OMB_UI_PORT: "5299", OMB_WEBHOOK_PORT: "8900" });
  expect(() => privacyPorts({ OMB_PRIVACY_UI_PORT: "8899" })).toThrow();
});

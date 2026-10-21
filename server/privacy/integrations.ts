import { createHash } from "node:crypto";
import type { SendTurnInput, McpServerSpec } from "../contracts.ts";
import type { PrivacySource } from "../../shared/personal-privacy.ts";
import { mcpStdioServer } from "../mcp-gate-config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

export function wrapPrivacyIntegrations(integrations: SendTurnInput["integrations"], sources: PrivacySource[], optional = false): SendTurnInput["integrations"] {
  if (!integrations) return integrations;
  const token = integrations.agents?.env.OMB_COMMS_TOKEN;
  const url = integrations.agents?.env.OMB_HARNESS_URL;
  const wrap = (server: McpServerSpec, source: PrivacySource, name: string) => {
    if (!token || !url) throw new Error("自動マスクにはアプリのツール接続が必要です。この定期実行は開始していません。");
    const upstream = mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } });
    if (!upstream) throw new Error("自動マスクができないMCP接続です。");
    const key = `MAUS_PRIVACY_PROXY_${createHash("sha256").update(token + name).digest("hex")}`;
    return { command: process.execPath, args: [SPAWNED_PROXIES.privacy, key], env: {
      ELECTRON_RUN_AS_NODE: "1", [key]: JSON.stringify({ upstream, url, token, source, automatic: sources.includes(source), optional, googleChat: name === "google_chat" }),
    } };
  };
  const result = { ...integrations };
  for (const source of ["browser", "composio", "data"] as const) {
    const server = integrations[source];
    if ((sources.includes(source) || optional) && server) result[source] = wrap(server, source, source);
  }
  if ((sources.includes("custom") || optional) && integrations.custom) result.custom = Object.fromEntries(Object.entries(integrations.custom).map(([name, server]) => [name, wrap(server, "custom", name)]));
  return result;
}

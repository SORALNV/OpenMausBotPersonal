import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "yaml";

const { values } = parseArgs({ options: { url: { type: "string" }, bot: { type: "string" } }, strict: true });
if (!values.url || !values.bot) throw new Error("Specify --url http://127.0.0.1:PORT and --bot NAME");
const base = new URL(values.url);
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Use an explicit local app URL");
const text = readFileSync(new URL("../integrations/himalaya-mail/SKILL.md", import.meta.url), "utf8");
const metadata = parse(text.match(/^---\n([\s\S]*?)\n---\n/u)?.[1] ?? "");
if (metadata?.name !== "himalaya-mail" || typeof metadata.description !== "string") throw new Error("Invalid local skill");
const api = async (path, body) => {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET", redirect: "error",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 403) throw new Error("This desktop protects skill changes. Use Mail Manager > Skills > Create command in the authenticated app; do not extract its launch capability or disable authentication.");
  if (!response.ok) throw new Error(`Local skill setup failed (HTTP ${response.status}); no raw response is forwarded`);
  return response.json();
};
const bots = (await api("/api/bots?messages=0")).bots.filter(bot => bot.name === values.bot && !bot.hidden);
if (bots.length !== 1) throw new Error("Select one existing bot with an unambiguous name");
const bot = bots[0];
if (bot.busy) throw new Error("Wait for this bot's current turn to finish before connecting");
const endpoint = `/api/bots/${encodeURIComponent(bot.id)}`;
const current = (await api(`${endpoint}/skills`)).skills.find(skill => skill.name === metadata.name);
if (current) {
  const saved = await api(`${endpoint}/skills/${metadata.name}`);
  if (saved.text !== text || !current.enabled) throw new Error("An existing skill differs or is disabled; review it in Bot Settings before replacing or enabling it");
} else {
  await api(`${endpoint}/skill-template`, { name: metadata.name, description: metadata.description, warnings: [], source: "local:himalaya-readonly", text, enabled: true });
}
const installed = (await api(`${endpoint}/skills`)).skills.find(skill => skill.name === metadata.name);
if (!installed?.enabled) throw new Error("Skill enablement was not confirmed");
console.log(JSON.stringify({ bot: bot.name, skill: installed.name, enabled: installed.enabled, changed: !current, access: "read-only" }, null, 2));

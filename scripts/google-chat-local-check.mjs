import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalPrivacyService } from "../server/privacy/service.ts";

const root = await mkdtemp(join(tmpdir(), "omb-chat-local-check-"));
const repo = new URL("../", import.meta.url).pathname;
Object.assign(process.env, {
  OMB_PERSONAL_BUILD: "1", OMB_PRIVACY_PYTHON: join(repo, ".privacy-dev/venv/bin/python"),
  OMB_PRIVACY_WORKER: join(repo, "scripts/privacy-worker.py"), OMB_PRIVACY_DEVICE: "mps",
  OMB_PRIVACY_CHECKPOINT: join(repo, ".privacy-dev/checkpoint/original"), TIKTOKEN_CACHE_DIR: join(repo, ".privacy-dev/tiktoken"),
});
const service = new PersonalPrivacyService(root, () => null);
service.protectThread = () => true;
const report = (stage, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), stage, ...details }));
const start = Date.now();
try {
  report("fetch_start");
  const credentials = JSON.parse(await readFile(new URL("../../GoogleChatExtensionMCP/.local/credentials.json", import.meta.url), "utf8"));
  const response = await fetch("http://127.0.0.1:17321/mcp", { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${credentials.mcpToken}`, "MCP-Protocol-Version": "2026-07-28", "X-GChat-Read-Only": "true",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_monitored_thread", arguments: {} } }), signal: AbortSignal.timeout(10000) });
  const rpc = await response.json();
  if (!response.ok || rpc.error || rpc.result?.isError) throw Error("FETCH_FAILED");
  const payload = rpc.result;
  const texts = [];
  const visit = value => { if (typeof value === "string") texts.push(value); else if (value && typeof value === "object") Object.values(value).forEach(visit); };
  visit(payload);
  report("fetch_complete", { elapsedMs: Date.now() - start, messages: payload.structuredContent?.result?.messages?.length, strings: texts.length, characters: texts.reduce((n, s) => n + s.length, 0), longestString: Math.max(0, ...texts.map(s => s.length)) });
  report("mask_start");
  let result;
  await service.internalRoute("isolated", () => {})({ path: "/api/internal/privacy-filter", method: "POST", req: {}, res: { setHeader() {} }, readBody: async () => ({ source: "custom", value: payload }), json: (_res, status, body) => { result = { status, body }; } });
  report("mask_complete", { elapsedMs: Date.now() - start, status: result.status, messages: result.body.value?.structuredContent?.result?.messages?.length });
  if (result.status !== 200) process.exitCode = 1;
} catch { report("failed", { elapsedMs: Date.now() - start }); process.exitCode = 1; }
finally { service.close(); await rm(root, { recursive: true, force: true }); }

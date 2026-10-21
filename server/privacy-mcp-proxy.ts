import { pathToFileURL } from "node:url";
import { createLineSplitter } from "./mcp-bridge.ts";
import { resolveCliSpawn } from "./env-path.ts";
import { spawnCli, killCliTree } from "./procs.ts";
import { stripControlPlaneEnv } from "./config.ts";
import { privacyToolCatalog, privacyToolRequest } from "./privacy/tool-option.ts";
import { randomUUID } from "node:crypto";

/** Only tool answers cross this boundary. A failed/unknown answer never falls back to the original bytes. */
export function runPrivacyMcpProxy(): void {
  const key = process.argv[2];
  if (!/^MAUS_PRIVACY_PROXY_[a-f0-9]{64}$/.test(key ?? "")) throw new Error("Missing private privacy proxy configuration");
  const config = JSON.parse(process.env[key] ?? "null");
  const url = new URL(config?.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash || typeof config.token !== "string" || !config.token) throw new Error("Invalid local privacy endpoint");
  const baseEnv = { ...process.env }; stripControlPlaneEnv(baseEnv);
  const inherited = Object.fromEntries(Object.entries(baseEnv).filter(([name]) => !/^(?:OMB_|OGB_|MAUS_PRIVACY_PROXY_)/.test(name)));
  const env = { ...inherited, ...config.upstream.env };
  for (const name of Object.keys(env)) if (name.startsWith("MAUS_PRIVACY_PROXY_")) delete env[name];
  const resolved = resolveCliSpawn(config.upstream.command, config.upstream.args ?? [], env);
  const child = spawnCli(resolved.command, resolved.args, { env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const pending = new Map<string, { method: string; model: boolean; diagnostic?: string; reporting?: Promise<void>; timer?: ReturnType<typeof setTimeout> }>();
  const requestKey = (id: unknown) => typeof id === "number" || typeof id === "string" ? `${typeof id}:${id}` : undefined;
  const abort = new AbortController();
  const report = async (id: string, phase: string) => {
    try {
      await fetch(new URL("/api/internal/google-chat-diagnostics", url), { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify({ id, phase }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) });
    } catch { /* Diagnostics never forward upstream error text. */ }
  };
  const blocked = (id: unknown, code: string) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `ローカル取得を停止しました (${code})。原文への代替経路や、結果不明の送信の再試行は行わないでください。` }] } });
  let stopped = false; let inputBytes = 0; let outputBytes = 0; let queued = 0;
  const stop = () => { if (stopped) return; stopped = true; process.exitCode = 1; for (const item of pending.values()) clearTimeout(item.timer); abort.abort(); process.stdin.pause(); void killCliTree(child); };
  const input = createLineSplitter(line => {
    inputBytes = 0;
    try {
      if (line.length > 2_000_000 || pending.size > 32) return stop();
      let frame = JSON.parse(line); const id = requestKey(frame.id);
      let model = config.automatic !== false;
      if (config.optional && frame.method === "tools/call") {
        const request = privacyToolRequest(frame); frame = request.frame; model ||= request.model;
      }
      if (id) {
        const item: { method: string; model: boolean; diagnostic?: string; reporting?: Promise<void>; timer?: ReturnType<typeof setTimeout> } = { method: frame.method, model };
        if (config.googleChat && frame.method === "tools/call" && ["get_monitored_thread", "get_thread", "get_recent_messages", "get_message", "search_messages", "get_unread_messages"].includes(frame.params?.name)) {
          item.diagnostic = randomUUID(); item.reporting = report(item.diagnostic, "start");
          item.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            void item.reporting?.then(() => report(item.diagnostic!, "UPSTREAM_TIMEOUT"));
            process.stdout.write(JSON.stringify(blocked(frame.id, "UPSTREAM_TIMEOUT")) + "\n");
          }, 30000);
        }
        pending.set(id, item);
      }
      child.stdin.write(JSON.stringify(frame) + "\n");
    } catch { stop(); }
  });
  process.stdin.on("data", chunk => { inputBytes += chunk.length; if (inputBytes > 2_000_000) stop(); else input.push(chunk); });
  process.stdin.on("end", () => { input.flush(); child.stdin.end(); });
  let queue = Promise.resolve();
  const output = createLineSplitter(line => {
    outputBytes = 0;
    if (++queued > 32) return stop();
    queue = queue.then(async () => {
      if (stopped) return;
      if (line.length > 2_000_000) return stop();
      let frame;
      try { frame = JSON.parse(line); } catch { return stop(); }
      const id = requestKey(frame.id); const request = id && pending.get(id);
      if (!request) return;
      pending.delete(id!);
      clearTimeout(request.timer);
      if (request.diagnostic) { await request.reporting; await report(request.diagnostic, "upstream_complete"); }
      if (request.method === "tools/list" && config.optional && frame.result) frame = { ...frame, result: privacyToolCatalog(frame.result) };
      if (request.method === "tools/call") {
        try {
          const response = await fetch(new URL("/api/internal/privacy-filter", url), {
            method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
            body: JSON.stringify({ source: config.source, value: frame.error ?? frame.result, model: request.model, ...(request.diagnostic ? { chatDiagnosticId: request.diagnostic } : {}) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(135_000)]),
          });
          if (!response.ok) {
            const failure = await response.json() as { code?: string };
            if (["MASK_FAILED", "MASK_TIMEOUT", "BODY_INVALID"].includes(failure.code ?? "")) throw new Error(failure.code);
            throw new Error("MASK_FAILED");
          }
          const body = await response.json() as { value?: unknown };
          if (!Object.hasOwn(body, "value")) throw new Error();
          frame = frame.error ? { jsonrpc: "2.0", id: frame.id, error: body.value } : { jsonrpc: "2.0", id: frame.id, result: body.value };
        } catch (error) {
          const code = error instanceof Error && ["MASK_TIMEOUT", "BODY_INVALID"].includes(error.message) ? error.message : "MASK_FAILED";
          if (request.diagnostic) await report(request.diagnostic, code);
          frame = blocked(frame.id, code);
        }
      }
      process.stdout.write(JSON.stringify(frame) + "\n");
    }).catch(stop).finally(() => { queued--; });
  });
  child.stdout.on("data", chunk => { outputBytes += chunk.length; if (outputBytes > 2_000_000) stop(); else output.push(chunk); });
  child.stdout.on("end", () => output.flush());
  child.on("error", stop);
  child.on("close", code => { void queue.finally(() => { process.exitCode = process.exitCode || code || 0; process.stdin.pause(); }); });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runPrivacyMcpProxy(); } catch { process.stderr.write("Local privacy proxy could not start. No tool result was forwarded.\n"); process.exitCode = 1; }
}

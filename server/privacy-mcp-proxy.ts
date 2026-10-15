import { pathToFileURL } from "node:url";
import { createLineSplitter } from "./mcp-bridge.ts";
import { resolveCliSpawn } from "./env-path.ts";
import { spawnCli, killCliTree } from "./procs.ts";
import { stripControlPlaneEnv } from "./config.ts";

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
  const pending = new Map<string, string>();
  const requestKey = (id: unknown) => typeof id === "number" || typeof id === "string" ? `${typeof id}:${id}` : undefined;
  const abort = new AbortController();
  let stopped = false; let inputBytes = 0; let outputBytes = 0; let queued = 0;
  const stop = () => { if (stopped) return; stopped = true; process.exitCode = 1; abort.abort(); process.stdin.pause(); void killCliTree(child); };
  const input = createLineSplitter(line => {
    inputBytes = 0;
    try {
      if (line.length > 2_000_000 || pending.size > 32) return stop();
      const frame = JSON.parse(line); const id = requestKey(frame.id);
      if (id) pending.set(id, frame.method);
      child.stdin.write(line + "\n");
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
      const id = requestKey(frame.id); const method = id && pending.get(id);
      if (!method) return;
      pending.delete(id!);
      if (method === "tools/call") {
        try {
          const response = await fetch(new URL("/api/internal/privacy-filter", url), {
            method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
            body: JSON.stringify({ source: config.source, value: frame.error ?? frame.result }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(150_000)]),
          });
          if (!response.ok) throw new Error();
          const body = await response.json() as { value?: unknown };
          if (!Object.hasOwn(body, "value")) throw new Error();
          frame = frame.error ? { jsonrpc: "2.0", id: frame.id, error: body.value } : { jsonrpc: "2.0", id: frame.id, result: body.value };
        } catch {
          frame = { jsonrpc: "2.0", id: frame.id, result: { isError: true, content: [{ type: "text", text: "Mac内の自動マスクに失敗・未対応のため、この取得結果をAIに渡していません。原文を読む別経路へ切り替えず、設定を確認してください。" }] } };
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

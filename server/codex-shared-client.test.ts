import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { CodexSharedClient } from "./codex-shared-client.ts";
import type { NativeAsk } from "./direct-codex-client.ts";

let root: string, socket: string, server: ReturnType<typeof createServer>, wss: WebSocketServer;
let calls: { method: string; params: any }[], clients: CodexSharedClient[], responses: any[];
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-shared-rpc-"))); socket = join(root, "control.sock");
  calls = []; clients = []; responses = [];
  server = createServer(); wss = new WebSocketServer({ server });
  wss.on("connection", ws => ws.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (!message.method) { responses.push(message); return; }
    calls.push(message);
    if (message.method === "hold" || message.id === undefined) return;
    ws.send(JSON.stringify({ id: message.id, result: message.method === "thread/resume" ? { thread: { id: message.params.threadId } } : {} }));
  }));
  server.listen(socket); await once(server, "listening"); chmodSync(socket, 0o600);
});
afterEach(async () => {
  for (const client of clients) await client.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
async function connect() { const client = new CodexSharedClient(socket); clients.push(client); await client.initialize(); return client; }
const until = async (ready: () => boolean) => { const deadline = Date.now() + 1000; while (!ready()) { if (Date.now() > deadline) throw Error("Fixture did not settle"); await new Promise(r => setTimeout(r, 5)); } };
it("disconnects one subscriber without stopping the server or another subscriber", async () => {
  const one = await connect(), two = await connect();
  await one.request("thread/resume", { threadId: "native" });
  await one.close();
  await expect(two.request("thread/read", { threadId: "native" })).resolves.toEqual({});
  expect(calls.filter(c => c.method === "thread/unsubscribe").map(c => c.params.threadId)).toEqual(["native"]);
});
it("does not deny a request that another connected client can answer", async () => {
  await connect(); const two = await connect(); let ask: NativeAsk | undefined;
  two.onAsk(value => { ask = value; });
  for (const ws of wss.clients) ws.send(JSON.stringify({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "native" } }));
  await until(() => Boolean(ask));
  expect(responses).toEqual([]);
  expect(ask!.answer({ decision: "accept" })).toBe(true);
  expect(ask!.answer({ decision: "accept" })).toBe(false);
  await until(() => responses.length === 1);
  expect(responses).toEqual([{ id: 77, result: { decision: "accept" } }]);
});
it("prevents stale approval after another client resolves the same native request", async () => {
  const client = await connect(); let ask: NativeAsk | undefined, resolved = false;
  client.onAsk(value => { ask = value; }); client.onEvent(method => { if (method === "serverRequest/resolved") resolved = true; });
  for (const ws of wss.clients) { ws.send(JSON.stringify({ id: 0, method: "item/fileChange/requestApproval", params: { threadId: "native" } })); ws.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "native", requestId: 0 } })); }
  await until(() => Boolean(ask) && resolved);
  expect(ask!.answer({ decision: "accept" })).toBe(false); expect(responses).toEqual([]);
});
it("does not resend or fall back after an ambiguous timeout", async () => {
  const client = await connect();
  await expect(client.request("hold", { threadId: "native" }, 10)).rejects.toThrow("do not resend");
  expect(calls.filter(c => c.method === "hold")).toHaveLength(1);
});
it("rejects sockets or parent directories accessible by other users", () => {
  chmodSync(socket, 0o666); expect(() => new CodexSharedClient(socket)).toThrow("owner-private");
  chmodSync(socket, 0o600); chmodSync(root, 0o755); expect(() => new CodexSharedClient(socket)).toThrow("owner-private");
});
it("supports an owner-private native socket alias while validating its actual target", async () => {
  const alias = join(root, "native-alias.sock"); symlinkSync(socket, alias);
  const client = new CodexSharedClient(alias); clients.push(client); await client.initialize();
  await expect(client.request("thread/read", { threadId: "native" })).resolves.toEqual({});
  chmodSync(socket, 0o666); expect(() => new CodexSharedClient(alias)).toThrow("owner-private");
});

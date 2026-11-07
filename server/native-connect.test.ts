import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { NativeAntigravityTransport } from "../scripts/native-antigravity-transport.mjs";
import { NativeConnect } from "./native-connect.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { availableTools, catalogProfileFromEnv } from "./drivers/agents-catalog.ts";
import { callTool } from "./drivers/agents-call.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTempDir(directory); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omb-native-connect-test-"))); directories.push(directory);
  const state = join(directory, "private"), native = join(directory, "native");
  mkdirSync(state, { mode: 0o700 }); mkdirSync(native, { mode: 0o700 });
  writeFileSync(join(state, "native-connect.json"), JSON.stringify({ enabled: true, model: "claude-sonnet-5-5-medium", binary: process.execPath }), { mode: 0o600 });
  const transport = new NativeAntigravityTransport({ command: process.execPath, args: [fileURLToPath(new URL("../scripts/testing/fake-native-antigravity.mjs", import.meta.url))],
    directory: join(state, "sessions"), env: { ...process.env, FAKE_AGY_DIRECTORY: native } });
  const broker = new NativeConnect(state, transport);
  const run = (requestId: string, prompt: string, threadId = "thread-a", overrides: Partial<Parameters<NativeConnect["run"]>[0]> = {}) => broker.run({
    botId: "bot-a", threadId, requestId, prompt, cwd: directory, signal: new AbortController().signal, requireActive: () => {}, progress: () => {}, ...overrides });
  const receipts = () => readFileSync(join(native, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { directory, state, native, transport, broker, run, receipts };
}

it("retains the destination's native conversation across delegated jobs and broker restart", async () => {
  const { broker, run, state, transport, directory, receipts } = fixture();
  const first = await run("request-one", "NC_AGY_FIRST");
  const next = new NativeConnect(state, transport);
  const second = await next.run({ botId: "bot-a", threadId: "thread-a", requestId: "request-two", prompt: "NC_AGY_SECOND", cwd: directory,
    signal: new AbortController().signal, requireActive: () => {}, progress: () => {} });
  expect(first.nativeId).toBe(second.nativeId); expect(second.text).toContain(":2:NC_AGY_SECOND");
  expect(receipts().map(value => value.text)).toEqual(["NC_AGY_FIRST", "NC_AGY_SECOND"]);
  expect((await broker.status("bot-a", "thread-a")).nativeConversationId).toBe(first.nativeId);
});

it("returns a completed receipt without executing the same delegated task twice", async () => {
  const { run, receipts } = fixture();
  const first = await run("request-one", "same");
  const repeated = await run("request-one", "same");
  expect(repeated).toMatchObject({ nativeId: first.nativeId, text: first.text, reusedReceipt: true });
  expect(receipts()).toHaveLength(1);
});

it("keeps independent native histories for two OMB threads", async () => {
  const { run } = fixture();
  const a = await run("request-a", "one"), b = await run("request-b", "two", "thread-b");
  expect(a.nativeId).not.toBe(b.nativeId);
});

it("blocks an uncertain job after failure, including after restart", async () => {
  const { run, state, transport, directory, receipts } = fixture();
  await expect(run("request-one", "DISCONNECT")).rejects.toThrow();
  const restarted = new NativeConnect(state, transport);
  await expect(restarted.run({ botId: "bot-a", threadId: "thread-a", requestId: "request-one", prompt: "DISCONNECT", cwd: directory,
    signal: new AbortController().signal, requireActive: () => {}, progress: () => {} })).rejects.toThrow(/再送/u);
  expect(receipts()).toHaveLength(1);
});

it("rejects expired authority before any native prompt and after a completed cached receipt", async () => {
  const { run, broker } = fixture();
  const denied = () => { throw Error("expired capability"); };
  await expect(run("request-one", "one", "thread-a", { requireActive: denied })).rejects.toThrow(/expired/u);
  expect(await broker.status("bot-a", "thread-a")).toMatchObject({ connected: false, busy: false });
  await run("request-two", "two");
  await expect(run("request-two", "two", "thread-a", { requireActive: denied })).rejects.toThrow(/expired/u);
});

it("owner Stop cancels only that thread's native job and settles broker busy state", async () => {
  const { run, broker } = fixture();
  const pending = expect(run("request-hang", "HANG")).rejects.toThrow();
  await expect.poll(() => broker.snapshot().active).toBe(1);
  broker.stop("bot-a", "thread-a");
  await pending;
  expect(broker.snapshot().active).toBe(0);
});

it("does not let configuration change during native work", async () => {
  const { run, broker } = fixture();
  const pending = expect(run("request-hang", "HANG")).rejects.toThrow();
  await expect.poll(() => broker.snapshot().active).toBe(1);
  await expect(broker.configure({ enabled: false, model: "claude-sonnet-5-5-medium" })).rejects.toThrow(/委託中/u);
  broker.close(); await pending;
});

it("advertises delegation only when explicitly enabled, without replacing the main model catalog", () => {
  const off = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-a" }));
  const on = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-a", OMB_NATIVE_CONNECT: "1" }));
  expect(off.some(tool => tool.name === "native_connect")).toBe(false);
  expect(on.some(tool => tool.name === "native_connect")).toBe(true);
  expect(on.some(tool => tool.name === "coordinate_bots")).toBe(true);
  expect(on.some(tool => tool.name === "memory_update")).toBe(true);
});

it("routes the native delegation tool through the normal capability client and rejects identity injection", async () => {
  const calls: unknown[] = [];
  const context = { botId: "bot-a", threadId: "thread-a", depth: 0, externalRuntime: false, sharedComputers: false,
    client: { api: async () => ({}), apiResponse: async (path: string, init?: RequestInit) => { calls.push({ path, body: JSON.parse(String(init?.body)) }); return { ok: true, status: 200, body: { text: "native answer" } }; } } };
  expect(await callTool("native_connect", { action: "run", prompt: "ordinary prompt" }, context)).toEqual({ text: JSON.stringify({ text: "native answer" }) });
  expect(calls).toEqual([{ path: "/api/internal/native-connect", body: { action: "run", prompt: "ordinary prompt" } }]);
  expect((await callTool("native_connect", { action: "run", prompt: "x", botId: "other" }, context)).isError).toBe(true);
  expect(calls).toHaveLength(1);
});

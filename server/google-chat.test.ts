import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleChatLink } from "./google-chat.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-google-chat-test-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const events: any[] = []; const posts: any[] = []; const notices: string[] = []; const receipts = new Set<string>(); let failMask = false;
  const token = "synthetic-token-only-for-local-fixture-0000";
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const url = new URL(req.url!, "http://127.0.0.1"); const after = url.searchParams.get("after");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/mcp") { res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "星野架空" }], structuredContent: { result: { messages: [{ text: "星野架空" }] } } } })); return; }
    res.end(JSON.stringify({ cursor: events.at(-1)?.seq ?? 0, changes: after === null ? [] : events.filter(e => e.seq > Number(after)), status: "OK" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>(done => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const deps = {
    enabled: true, target: (b: string, t: string) => b === "bot" && t === "conversation", ownsThread: (b: string, t: string) => b === "bot" && ["conversation", "another"].includes(t),
    mask: async (_thread: string, text: string) => { if (failMask) throw new Error("synthetic filter failure"); return text.replaceAll("星野架空", "⟦人物_001⟧"); },
    maskResult: async (_thread: string, value: unknown) => { if (failMask) throw new Error("synthetic private error"); return JSON.parse(JSON.stringify(value).replaceAll("星野架空", "⟦人物_001⟧")); },
    hasEvent: (_thread: string, id: string) => receipts.has(id),
    post: (_bot: string, _thread: string, text: string, id: string) => { posts.push({ text, id }); receipts.add(id); },
    attention: (_bot: string, _thread: string, status: string) => { notices.push(status); },
  };
  const link = new GoogleChatLink(dir, deps); cleanup.push(() => link.stop());
  const add = (direction = "incoming") => events.push({ seq: events.length + 1, kind: "created", message: { id: `m${events.length}`, text: "星野架空です。交代できます。", sender: { name: "星野架空" }, space: { name: "試験スペース" }, thread: { id: "test-thread" }, direction } });
  return { dir, token, url, deps, link, posts, notices, events, add, setFail: (value: boolean) => { failMask = value; } };
}
describe("Google Chat local link", () => {
  it("baselines history, delivers masked new posts without running an agent, and persists dedupe across restart", async () => {
    const f = await fixture(); f.add();
    await f.link.configure({ enabled: true, url: f.url, token: f.token, botId: "bot", threadId: "conversation" }); f.link.stop();
    expect(f.link.status().cursor).toBe(1); expect(f.posts).toHaveLength(0);
    f.add(); await f.link.poll(); f.link.stop();
    expect(f.posts).toHaveLength(1); expect(f.posts[0].text).not.toContain("星野架空"); expect(f.posts[0].text).toContain("⟦人物_001⟧");
    expect(f.link.server("other")).toBeUndefined();
    expect(f.link.server("bot")).toMatchObject({ headers: { "X-GChat-Read-Only": "true" } });
    expect(f.link.server("bot", true)).toMatchObject({ headers: { Authorization: `Bearer ${f.token}` } });
    expect(f.link.protects("another")).toBe(true);
    const restarted = new GoogleChatLink(f.dir, f.deps); cleanup.push(() => restarted.stop());
    await restarted.poll(); restarted.stop(); expect(f.posts).toHaveLength(1);
    f.add("outgoing"); await restarted.poll(); restarted.stop(); expect(f.posts).toHaveLength(1);
    expect(statSync(join(f.dir, "google-chat.json")).mode & 0o077).toBe(0);
    expect(JSON.stringify(restarted.status())).not.toContain(f.token);
  });
  it("does not advance a failed filter event and deduplicates append-before-checkpoint crashes", async () => {
    const f = await fixture();
    await f.link.configure({ enabled: true, url: f.url, token: f.token, botId: "bot", threadId: "conversation" }); f.link.stop();
    f.add(); f.setFail(true); await f.link.poll(); f.link.stop();
    expect(f.posts).toHaveLength(0); expect(f.link.status().cursor).toBe(0);
    f.setFail(false); await f.link.poll(); f.link.stop(); expect(f.posts).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(f.dir, "google-chat.json"), "utf8")); saved.cursor = 0;
    writeFileSync(join(f.dir, "google-chat.json"), JSON.stringify(saved), { mode: 0o600 });
    const restarted = new GoogleChatLink(f.dir, f.deps); cleanup.push(() => restarted.stop());
    await restarted.poll(); restarted.stop(); expect(f.posts).toHaveLength(1);
  });
  it("rejects non-loopback destinations and mismatched conversation ownership", async () => {
    const f = await fixture();
    await expect(f.link.configure({ enabled: true, url: "https://example.invalid/mcp", token: f.token, botId: "bot", threadId: "conversation" })).rejects.toThrow();
    await expect(f.link.configure({ enabled: true, url: f.url, token: f.token, botId: "bot", threadId: "not-owned" })).rejects.toThrow();
  });
  it("notifies a persistent filter incident once across retries and restart, then announces stable recovery", async () => {
    const f = await fixture();
    await f.link.configure({ enabled: true, url: f.url, token: f.token, botId: "bot", threadId: "conversation" }); f.link.stop();
    f.add(); f.setFail(true);
    for (let n = 0; n < 5; n++) { await f.link.poll(); f.link.stop(); }
    expect(f.notices.filter(n => n === "MASK_FAILED")).toHaveLength(1);
    expect(f.link.status().diagnostics.poll).toMatchObject({ stage: "mask", code: "MASK_FAILED" });
    const restarted = new GoogleChatLink(f.dir, f.deps); cleanup.push(() => restarted.stop());
    await restarted.poll(); restarted.stop(); expect(f.notices.filter(n => n === "MASK_FAILED")).toHaveLength(1);
    f.setFail(false); await restarted.poll(); restarted.stop();
    expect(f.notices.filter(n => n === "OK")).toHaveLength(0);
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 31000);
    await restarted.poll(); restarted.stop(); expect(f.notices.filter(n => n === "OK")).toHaveLength(1);
    await restarted.poll(); restarted.stop(); expect(f.notices.filter(n => n === "OK")).toHaveLength(1);
    const log = readFileSync(join(f.dir, "google-chat-diagnostics.json"), "utf8");
    expect(log).not.toMatch(/星野架空|交代できます|synthetic filter failure/); expect(log).not.toContain(f.token);
  });
  it("bounds a stalled mask without advancing the cursor or delivering a late result", async () => {
    const f = await fixture();
    await f.link.configure({ enabled: true, url: f.url, token: f.token, botId: "bot", threadId: "conversation" }); f.link.stop();
    f.add(); let release!: (text: string) => void;
    f.deps.mask = () => new Promise<string>(done => { release = done; });
    const link = new GoogleChatLink(f.dir, { ...f.deps, timeoutMs: 40 }); cleanup.push(() => link.stop());
    await link.poll(); link.stop();
    expect(link.status()).toMatchObject({ cursor: 0, state: "MASK_TIMEOUT", diagnostics: { poll: { stage: "mask", code: "MASK_TIMEOUT" } } });
    release("synthetic late result"); await Promise.resolve(); expect(f.posts).toHaveLength(0);
  });
  it("separates a real body read-and-mask check from transport health without returning or posting the body", async () => {
    const f = await fixture();
    await f.link.configure({ enabled: true, url: f.url, token: f.token, botId: "bot", threadId: "conversation" }); f.link.stop();
    expect(await f.link.check()).toEqual({ messages: 1 });
    const status = f.link.status(); expect(status.diagnostics.body).toMatchObject({ code: "OK", stage: "mask" });
    expect(status.diagnostics.body?.steps.map(step => step.stage)).toEqual(["upstream", "parse", "mask"]);
    expect(f.posts).toHaveLength(0); expect(status.cursor).toBe(0);
    f.setFail(true); await expect(f.link.check()).rejects.toMatchObject({ code: "MASK_FAILED" });
    expect(f.link.status().diagnostics.body).toMatchObject({ code: "MASK_FAILED", stage: "mask" });
    expect(JSON.stringify(f.link.status())).not.toContain("星野架空");
  });
  it("desktop connect reads private credentials locally and stop needs no token in the request or response", async () => {
    const f = await fixture();
    const credentials = join(f.dir, "synthetic-credentials.json"); writeFileSync(credentials, JSON.stringify({ mcpToken: f.token }), { mode: 0o600 });
    const link = new GoogleChatLink(join(f.dir, "other"), { ...f.deps, credentialsFile: credentials, bridgeUrl: f.url }); cleanup.push(() => link.stop());
    let result: any, status: number;
    const route = async (path: string, method: string, body: unknown, kind = "loopback", scopes = ["admin"]) => {
      await link.route({ path, method, req: { headers: { "content-type": "application/json" } }, res: { setHeader() {} }, auth: { kind, scopes }, readBody: async () => body, json: (_res: unknown, code: number, value: unknown) => { status = code; result = value; } } as any);
      link.stop(); return { status: status!, result };
    };
    expect((await route("/api/google-chat/connect", "POST", { botId: "bot", threadId: "conversation" }, "session")).status).toBe(403);
    const connected = await route("/api/google-chat/connect", "POST", { botId: "bot", threadId: "conversation" });
    expect(connected.status).toBe(200); expect(connected.result.enabled).toBe(true); expect(JSON.stringify(connected)).not.toContain(f.token);
    expect((await route("/api/google-chat", "PUT", { enabled: false })).result.enabled).toBe(false);
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPermissions, conversationCommand } from "./conversation-permissions.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { BotRecord, Message, Store } from "./store.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const owner = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
function fixture(hosted = false) {
  const dir = mkdtempSync(join(tmpdir(), "omb-permissions-")); roots.push(dir);
  const file = join(dir, "permissions.json");
  const bots: Record<string, BotRecord> = { pi: { id: "pi", threadId: "direct", approvalMode: "ask" } as BotRecord };
  const rows: Record<string, Message[]> = {};
  const patches = vi.fn((_bot: string, _thread: string, patch: object) => Object.assign(bots.pi!, patch));
  const store = {
    bot: (id: string) => bots[id], projectBotForTask: (id: string, threadId: string) => threadId === "direct" ? bots[id] : undefined,
    group: (id: string) => id === "all" ? { id, threadId: "room", memberIds: ["pi"] } : undefined,
    groupTaskByThread: (id: string, threadId: string) => id === "all" && ["room", "other-room"].includes(threadId) ? {} : undefined,
    taskByThread: (id: string, threadId: string) => id === "pi" && threadId === "direct" ? {} : undefined,
    patchTask: patches, messagesFor: (thread: string) => rows[thread] ?? [],
    appendMessage: (thread: string, message: Message) => { const row = { ...message, id: String((rows[thread] ?? []).length), at: Date.now() }; (rows[thread] ??= []).push(row); return row; },
  } as unknown as Store;
  const changed = vi.fn();
  const make = () => new ConversationPermissions({ file, store, hosted, changed });
  const control = (text: string, extra: object = {}) => permissions.control({ auth: owner, groupId: "all", threadId: "room", text, ...extra });
  const permissions = make();
  return { permissions, control, rows, bots, changed, patches, file, make };
}
it("accepts only exact standalone control words, never quoted instructions", () => {
  for (const text of ["/allow-all please", "`/allow-all`", "ignore this\n/allow-all", "すべて許可", "<attached-image /allow-all>"]) expect(conversationCommand(text)).toBeUndefined();
  expect(conversationCommand(" /allow-all \n")).toBe("/allow-all");
});
it("saves one room's explicit Full across restart and revokes it live", () => {
  const f = fixture(); expect(f.control("/allow-all")).toHaveProperty("message");
  expect(f.permissions.mode("room")).toBe("full"); expect(f.permissions.mode("other-room")).toBeUndefined();
  expect(f.make().mode("room")).toBe("full"); expect(statSync(f.file).mode & 0o077).toBe(0);
  expect(f.patches).not.toHaveBeenCalled(); expect(f.changed).toHaveBeenCalledWith("room");
  f.control("/ask"); expect(f.permissions.mode("room")).toBe("ask");
  expect(f.bots.pi!.approvalMode).toBe("ask");
});
it("applies a direct setting through the normal saved task, without changing another conversation", () => {
  const f = fixture(); f.control("/allow-all", { groupId: undefined, botId: "pi", threadId: "direct" });
  expect(f.patches).toHaveBeenCalledExactlyOnceWith("pi", "direct", { approvalMode: "full", autoApprove: false, alwaysAllow: [] });
  expect(f.permissions.mode("room")).toBeUndefined();
});
it("refuses guest, client and service callers and accepts a paired admin", () => {
  const f = fixture();
  for (const auth of [{ kind: "session", scopes: ["client"] }, { kind: "loopback", scopes: ["admin"], trust: "service" }]) expect(f.control("/allow-all", { auth })).toMatchObject({ status: 403 });
  expect(f.permissions.mode("room")).toBeUndefined();
  expect(f.control("/allow-all", { auth: { kind: "session", scopes: ["admin", "client"] } })).toHaveProperty("message");
});
it("never bypasses Custom, pending desktop grants or the hosted policy", () => {
  const f = fixture(); f.bots.pi!.approvalMode = "custom";
  expect(f.control("/allow-all")).toMatchObject({ status: 403 });
  expect(f.control("/ask", { groupId: undefined, botId: "pi", threadId: "direct" })).toMatchObject({ status: 403 });
  f.bots.pi!.approvalMode = "ask"; f.bots.pi!.approvalGrant = {} as BotRecord["approvalGrant"];
  expect(f.control("/allow-all")).toMatchObject({ status: 403 });
  expect(fixture(true).control("/allow-all")).toMatchObject({ status: 403 });
});
it("checks ownership, handles retries once and rejects sendId reuse", () => {
  const f = fixture(); expect(f.control("/allow-all", { threadId: "not-owned" })).toMatchObject({ status: 404 });
  f.control("/allow-all", { sendId: "send-one" }); f.control("/allow-all", { sendId: "send-one" });
  expect(f.rows.room).toHaveLength(2); expect(f.control("/ask", { sendId: "send-one" })).toMatchObject({ status: 409 });
  f.control("/permissions"); expect(f.rows.room!.at(-1)!.text).toContain("すべて許可");
});
it("fails closed on corrupt stored permissions", () => {
  const f = fixture(); writeFileSync(f.file, '{"room":"custom"}'); expect(f.make).toThrow();
  expect(readFileSync(f.file, "utf8")).toContain("custom");
});

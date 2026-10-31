import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, TaskRecord } from "../store.ts";
import { createInternalThreadWaitRoutes, type AssignmentWaitSnapshot } from "./internal-thread-waits.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
const bot = (id: string, extra: Partial<BotRecord> = {}) => ({ id, name: id, section: "Ops", ...extra }) as BotRecord;
async function fixture() {
  const state = { caller: bot("chief", { chiefOfStaff: true }), active: true, token: "first", waiting: true, parsing: (() => {}), assignments: [] as AssignmentWaitSnapshot[] };
  const bots = [state.caller, bot("target"), bot("private", { section: "Private" }), bot("hidden", { hidden: true })];
  const clear = vi.fn(async () => ({ teammatesLeftRunning: 1 }));
  const audit = vi.fn();
  const clearAssignment = vi.fn(() => true);
  const route = createInternalThreadWaitRoutes({
    caller: () => state.caller, callerThreadId: "chief-live", bots: () => bots,
    tasks: id => [{ threadId: id + "-wait", title: "Fixture" }, { threadId: "chief-live", title: "Current" }] as TaskRecord[],
    snapshot: () => state.waiting ? { token: state.token, kind: "input" } : null,
    requireActive: () => { if (!state.active) throw Object.assign(new Error("expired"), { status: 401 }); },
    clear, audit, assignments: () => state.assignments, clearAssignment, readBody: async () => { const value = await readBody(request!); state.parsing(); return value; },
  });
  let request: Parameters<typeof readBody>[0];
  const server = createServer(async (req, res) => {
    request = req;
    const url = new URL(req.url!, "http://localhost");
    try { if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method!, auth: {} as RequestAuth, json, readBody })) json(res, 404, {}); }
    catch (error) { json(res, (error as { status?: number }).status ?? 500, { error: String(error) }); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const post = async (body: unknown) => { const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/thread-waits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { state, clear, clearAssignment, audit, post };
}
const cancel = { action: "clear", toBotId: "target", toThreadId: "target-wait", expectedToken: "first", reason: "不要な待機を取り消す" };
it("lists only reachable waits, excluding the live caller, without mutating anything", async () => {
  const f = await fixture();
  expect((await f.post({ action: "list" })).body.waits.map((x: { botId: string }) => x.botId)).toEqual(["chief", "target"]);
  expect(f.clear).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
});
it("clears the exact wait with an audit and an explicit cancellation result", async () => {
  const f = await fixture(); expect(await f.post(cancel)).toMatchObject({ status: 200, body: { cleared: true, teammatesLeftRunning: 1 } });
  expect(f.clear).toHaveBeenCalledExactlyOnceWith("target", "target-wait", cancel.reason);
  expect(f.audit).toHaveBeenCalledExactlyOnceWith("target", "target-wait", cancel.reason);
});
it("refuses ordinary, hidden and demoted chiefs", async () => {
  const f = await fixture();
  for (const caller of [bot("chief"), bot("chief", { chiefOfStaff: true, hidden: true })]) { f.state.caller = caller; expect((await f.post(cancel)).status).toBe(403); }
  expect(f.clear).not.toHaveBeenCalled();
});
it("checks authority after parsing and refuses expired turn capabilities", async () => {
  const f = await fixture(); f.state.parsing = () => { f.state.active = false; }; expect((await f.post(cancel)).status).toBe(401); expect(f.clear).not.toHaveBeenCalled();
});
it("refuses inaccessible bots, forged thread ownership and the calling thread", async () => {
  const f = await fixture();
  expect((await f.post({ ...cancel, toBotId: "private" })).status).toBe(403);
  expect((await f.post({ ...cancel, toBotId: "hidden" })).status).toBe(403);
  expect((await f.post({ ...cancel, toThreadId: "private-wait" })).status).toBe(404);
  expect((await f.post({ ...cancel, toThreadId: "chief-live" })).status).toBe(409);
  expect(f.clear).not.toHaveBeenCalled();
});
it("refuses changed, ended and running waits instead of interrupting replacement work", async () => {
  const f = await fixture(); f.state.token = "replacement"; expect((await f.post(cancel)).status).toBe(409);
  f.state.waiting = false; expect((await f.post(cancel)).status).toBe(409); expect(f.clear).not.toHaveBeenCalled();
});
it("requires a token, reason and explicit action; never accepts an approval argument", async () => {
  const f = await fixture();
  for (const body of [{ ...cancel, expectedToken: undefined }, { ...cancel, reason: " " }, { ...cancel, approve: true }, { ...cancel, action: "allow" }]) expect((await f.post(body)).status).toBe(400);
  expect(f.clear).not.toHaveBeenCalled();
});

it("cancels one old room assignment even in the Chief's current room without stopping its active turn", async () => {
  const f = await fixture(); f.state.assignments = [{ waitId: "old-wait", botId: "chief", threadId: "chief-live", groupId: "room", title: "ALL", token: "room-token", kind: "input" }];
  expect((await f.post({ action: "list" })).body.waits).toContainEqual(expect.objectContaining({ waitId: "old-wait" }));
  expect((await f.post({ ...cancel, toBotId: "chief", toThreadId: "chief-live", waitId: "old-wait", expectedToken: "room-token" })).status).toBe(200);
  expect(f.clearAssignment).toHaveBeenCalledExactlyOnceWith("old-wait", cancel.reason); expect(f.clear).not.toHaveBeenCalled();
  expect(f.audit).toHaveBeenCalledWith("chief", "chief-live", cancel.reason, "room");
});
it("refuses changed, unrelated and no longer parked room assignments", async () => {
  const f = await fixture(); f.state.assignments = [{ waitId: "wait", botId: "target", threadId: "room-thread", groupId: "room", title: "ALL", token: "room-token", kind: "input" }];
  const request = { ...cancel, waitId: "wait", toThreadId: "room-thread", expectedToken: "room-token" };
  expect((await f.post({ ...request, toBotId: "chief" })).status).toBe(409);
  expect((await f.post({ ...request, expectedToken: "stale" })).status).toBe(409);
  f.clearAssignment.mockReturnValue(false); expect((await f.post(request)).status).toBe(409); expect(f.audit).not.toHaveBeenCalled();
});

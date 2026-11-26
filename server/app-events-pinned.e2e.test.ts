// App-event automations pinned to one chat, end to end on a real server (temporary home, scripted engine) with a fake
// Composio: an out-of-scope delivery is turned away by the filter before any run, a notification-free event runs in the
// pinned chat and posts nothing, a report-worthy event reaches the person there, a burst becomes one run, and a run
// whose pinned chat was deleted is refused without a chat being created for it. The pinned automation starts no chat in
// any of these cases.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

let broker: BrokerFake;
let owner: { id: string; token: string; userId: string };
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
const evidence: unknown[] = [];
const CHANNEL = "C0CJ1DMCQHY";

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  broker = await startBrokerFake();
  owner = await broker.install();
  broker.account(owner.userId, "slack");
  fixture = await launchVerificationServer({ ...process.env, OMB_COMPOSIO_BROKER_URL: broker.url, OMB_COMPOSIO_BROKER_TOKEN: owner.token }, undefined, undefined, undefined, undefined, { scripted: true });
  evidence.push({ fixture: fixture.info, broker: broker.url });
}, 60_000);

afterAll(async () => {
  writeFileSync(`${fixture.info.logPath}.app-events-pinned.json`, JSON.stringify(evidence, null, 2));
  console.info(JSON.stringify({ logPath: fixture.info.logPath, evidence: `${fixture.info.logPath}.app-events-pinned.json` }));
  await fixture?.close();
  await broker?.close();
  vi.restoreAllMocks();
});

it("runs every event in the pinned chat and starts no chat in any case", async () => {
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const { bot } = await cli("new-bot", "--name", "Scout");
  const mainChat = bot.activeTaskId as string;
  const messages = async () => (await api("GET", `/api/threads/${mainChat}/messages?limit=200`)).messages as any[];
  const tasks = async () => {
    const snapshot = await api("GET", "/api/bots?messages=0");
    return ((snapshot.bots ?? []).find((candidate: any) => candidate.id === bot.id)?.tasks ?? []) as Array<{ threadId: string }>;
  };
  // The saved data half of the same claim.
  const savedTasks = () => (JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; tasks?: Array<{ threadId: string }> }>)
    .find((candidate) => candidate.id === bot.id)!.tasks?.map((task) => task.threadId) ?? [];
  const plan = (reply: string) => writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [], reply } }));
  const runOf = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const deliver = (remoteId: string, data: Record<string, unknown>, eventId: string) => broker.deliver(remoteId, data, eventId);

  const created = await api("POST", "/api/app-triggers", {
    botId: bot.id, name: "Watch the DM", app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED",
    prompt: "必要な新着だけこのチャットで知らせる。雑談や相づちは知らせず、報告文も出さない。",
    filter: { text: CHANNEL }, conversationThreadId: mainChat,
  }, 201);
  const id = created.trigger.id as string;
  const remoteId = created.trigger.remote.triggerId as string;
  expect(created.trigger).toMatchObject({ conversationThreadId: mainChat, filter: { text: CHANNEL } });
  expect(await tasks()).toHaveLength(1);
  expect(savedTasks()).toHaveLength(1);
  evidence.push({ pinned: created.trigger });

  // Out of scope: another channel's post never reaches a run, and nothing is created.
  const before = turns().length;
  expect((await deliver(remoteId, { channel_id: "C_OTHER", channel: "C_OTHER", text: "hello" }, "pin_out_1")).status).toBe(200);
  await expect.poll(async () => (await api("GET", "/api/app-triggers")).attempts.filter((attempt: any) => attempt.eventId === "pin_out_1")[0]?.outcome, { timeout: 30_000 }).toBe("filtered");
  expect((await api("GET", "/api/app-triggers")).attempts.find((attempt: any) => attempt.eventId === "pin_out_1")).toMatchObject({ outcome: "filtered", reason: "did not match the filter" });
  expect(await runOf(id as string)).toBeUndefined();
  expect(await tasks()).toHaveLength(1);
  expect(savedTasks()).toHaveLength(1);
  expect(turns().length).toBe(before);

  // Notification-worthy: the run works in the pinned chat, and the reply lands there.
  plan("DMで実験の開始報告がありました。");
  expect((await deliver(remoteId, { channel_id: CHANNEL, channel: CHANNEL, text: "実験を始めます", ts: "1795426461.1" }, "pin_in_1")).status).toBe(200);
  let runId = "";
  await expect.poll(async () => {
    const attempt = (await api("GET", "/api/app-triggers")).attempts.find((attempt: any) => attempt.eventId === "pin_in_1");
    runId = attempt?.runId ?? "";
    return attempt?.outcome;
  }, { timeout: 30_000 }).toBe("started");
  await expect.poll(async () => (await runOf(runId))?.status, { timeout: 40_000 }).toBe("completed");
  expect(await runOf(runId)).toMatchObject({ threadId: mainChat, conversationThreadId: mainChat });
  evidence.push({ notificationRun: await runOf(runId), messages: (await messages()).map((message) => ({ kind: message.kind, text: String(message.text ?? "").slice(0, 120) })) });
  expect((await messages()).some((message) => message.role === "bot" && String(message.text ?? "").includes("実験の開始報告"))).toBe(true);
  expect(await tasks()).toHaveLength(1);
  expect(savedTasks()).toHaveLength(1);
  evidence.push({ notificationRun: await runOf(runId) });

  // Notification-free: the event runs in the pinned chat, but the person sees nothing new there.
  plan("");
  const messageCount = (await messages()).filter((message: any) => message.kind === "text").length;
  expect((await deliver(remoteId, { channel_id: CHANNEL, channel: CHANNEL, text: "そう！ありがとう！", ts: "1795426461.2" }, "pin_in_2")).status).toBe(200);
  await expect.poll(async () => {
    const attempt = (await api("GET", "/api/app-triggers")).attempts.filter((attempt: any) => attempt.eventId === "pin_in_2")[0];
    return attempt?.outcome;
  }, { timeout: 30_000 }).toBe("started");
  const quietRunId = (await api("GET", "/api/app-triggers")).attempts.find((attempt: any) => attempt.eventId === "pin_in_2")!.runId;
  await expect.poll(async () => (await runOf(quietRunId))?.status, { timeout: 40_000 }).toBe("completed");
  evidence.push({ quietRun: await runOf(quietRunId) });
  expect(await runOf(quietRunId)).toMatchObject({ threadId: mainChat });
  expect((await runOf(quietRunId))?.output ?? "").toBe("");
  // The quiet turn leaves no visible line in the chat (its digest chip stays behind the tool-activity switch).
  expect((await messages()).filter((message: any) => message.kind === "text").length).toBe(messageCount);
  expect(await tasks()).toHaveLength(1);
  expect(savedTasks()).toHaveLength(1);

  // Consecutive arrivals become one run, still in the pinned chat.
  plan("2件の新着をまとめて知らせます。");
  const messageCountBeforeBurst = (await messages()).length;
  const turnCountBeforeBurst = turns().length;
  expect((await deliver(remoteId, { channel_id: CHANNEL, channel: CHANNEL, text: "1件目", ts: "1795426461.3" }, "pin_burst_1")).status).toBe(200);
  expect((await deliver(remoteId, { channel_id: CHANNEL, channel: CHANNEL, text: "2件目", ts: "1795426461.4" }, "pin_burst_2")).status).toBe(200);
  await expect.poll(async () => {
    const attempt = (await api("GET", "/api/app-triggers")).attempts.find((attempt: any) => attempt.eventId === "pin_burst_2");
    return attempt?.outcome;
  }, { timeout: 30_000 }).toBe("joined");
  const burstRunId = (await api("GET", "/api/app-triggers")).attempts.find((attempt: any) => attempt.eventId === "pin_burst_2")!.runId as string;
  await expect.poll(async () => (await runOf(burstRunId))?.status, { timeout: 40_000 }).toBe("completed");
  expect(turns().length).toBe(turnCountBeforeBurst + 1);
  expect(await tasks()).toHaveLength(1);
  expect(savedTasks()).toHaveLength(1);
  const chatCountBeforeDelete = (await messages()).length;
  expect(chatCountBeforeDelete).toBeGreaterThanOrEqual(messageCountBeforeBurst);

  // The pinned chat was deleted: the next in-scope event is refused with the reason on its record, and nothing is created.
  await api("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: [mainChat] });
  expect((await deliver(remoteId, { channel_id: CHANNEL, channel: CHANNEL, text: "実験の予定を知らせます", ts: "1795426461.5" }, "pin_gone_1")).status).toBe(200);
  let goneRunId = "";
  await expect.poll(async () => {
    const attempt = (await api("GET", "/api/app-triggers")).attempts.find((attempt: any) => attempt.eventId === "pin_gone_1");
    goneRunId = attempt?.runId ?? "";
    return attempt?.outcome;
  }, { timeout: 30_000 }).toBe("started");
  await expect.poll(async () => (await runOf(goneRunId))?.status, { timeout: 40_000 }).toBe("failed");
  const refused = await runOf(goneRunId);
  expect(refused).toMatchObject({ errorCode: "routines.server.conversationGone" });
  expect(refused.threadId).toBeUndefined();
  // Deleting the chat leaves the bot its one auto-made empty chat (existing store behaviour); the refused run joined
  // nothing and wrote nothing anywhere.
  const afterDelete = ((await api("GET", "/api/bots?messages=0")).bots ?? []).find((candidate: any) => candidate.id === bot.id)?.tasks ?? [];
  evidence.push({ afterDelete });
  expect(afterDelete).toHaveLength(1);
  expect(afterDelete[0].threadId).not.toBe(mainChat);
  expect(((await api("GET", `/api/threads/${afterDelete[0].threadId}/messages?limit=50`)).messages ?? []).filter((message: any) => message.kind === "text")).toHaveLength(0);
  expect(savedTasks()).toHaveLength(1);
  evidence.push({ refusedRun: refused });
}, 240_000);

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { isBackgroundThread } from "../shared/background-thread.ts";
import { createProxyHandler } from "../companion/src/proxy.ts";

it("keeps one visible conversation, queues background runs, preserves human input and releases completed CLI processes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-background-gate-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const phoneToken = "background-fixture-phone";
  const sidecar = createServer(createProxyHandler({
    harnessPort: new URL(fixture.info.url).port ? Number(new URL(fixture.info.url).port) : 80,
    authenticate: token => token === phoneToken ? { id: "background-phone", cloudDesktopAccess: false, browserControlAccess: false } : null,
    redeem: () => ({ error: "not used" }), serverName: () => "Background fixture",
  }));
  await new Promise<void>(resolve => sidecar.listen(0, "127.0.0.1", resolve));
  const phoneUrl = `http://127.0.0.1:${(sidecar.address() as { port: number }).port}`;
  const phone = async (path = "/api/bots?messages=0", method = "GET") => {
    const response = await fetch(`${phoneUrl}${path}`, { method, headers: { authorization: `Bearer ${phoneToken}` } });
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value;
  };
  const runs = async () => (await api("GET", "/api/routines")).runs as any[];
  const state = async (id: string) => (await runs()).find(run => run.id === id);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Background fixture", "--url", fixture.info.url]) as any;
    const saved = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    const main = (await saved()).threadId;
    const make = async (name: string) => (await api("POST", "/api/routines", {
      name, prompt: `Synthetic ${name}`, botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201)).routine;
    const first = await make("First background job");
    const second = await make("Second background job");
    const { run: one } = await api("POST", `/api/routines/${first.id}/run`, undefined, 201);
    await expect.poll(async () => (await state(one.id))?.status, { timeout: 15_000 }).toBe("running");
    const running = await state(one.id);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath)
      && JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === running.threadId,
    { timeout: 15_000 }).toBe(true);
    const firstPid = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid as number;
    const { run: two } = await api("POST", `/api/routines/${second.id}/run`, undefined, 201);
    expect((await state(two.id)).status).toBe("queued");
    expect((await state(two.id)).threadId).toBeUndefined();
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: main, text: "Synthetic human input" }, 202);
    await expect.poll(async () => (await saved()).tasks.find((task: any) => task.threadId === main)?.busy, { timeout: 15_000 }).toBe(true);
    expect((await state(two.id)).status).toBe("queued");
    expect((await saved()).tasks.filter((task: any) => !isBackgroundThread(task))).toHaveLength(1);
    evidence.push({ first: await state(one.id), second: await state(two.id), firstPid, during: await saved() });
    writeFileSync(gate, "finish the synthetic jobs");
    await expect.poll(async () => (await state(two.id))?.status, { timeout: 25_000 }).toBe("completed");
    await expect.poll(() => alive(firstPid), { timeout: 10_000 }).toBe(false);
    const completed = await state(two.id);
    const native = join(fixture.info.dataDir, "native", `${completed.threadId}.ndjson`);
    await expect.poll(() => existsSync(native) && readFileSync(native, "utf8").includes('"close":"idle"'), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await saved()).tasks.filter((task: any) => task.background && task.busy).length).toBe(0);
    const final = await saved();
    expect(final.tasks.filter((task: any) => !isBackgroundThread(task))).toHaveLength(1);
    const phoneBot = (await phone()).bots.find((candidate: any) => candidate.id === bot.id);
    expect(phoneBot.tasks).toHaveLength(1);
    expect(phoneBot.tasks[0].threadId).toBe(main);
    const detail = await phone(`/api/bots/${bot.id}/tasks/${completed.threadId}?messages=10`, "POST");
    expect(detail.bot.tasks.map((task: any) => task.threadId)).toContain(completed.threadId);
    expect((await phone(`/api/threads/${completed.threadId}/messages?limit=10`)).messages.length).toBeGreaterThan(0);
    expect((await phone()).bots.find((candidate: any) => candidate.id === bot.id).tasks).toHaveLength(1);
    expect((await saved()).tasks.length).toBe(final.tasks.length);
    const messages = (await api("GET", `/api/threads/${main}/messages?limit=100`)).messages;
    await expect.poll(async () => (await api("GET", `/api/threads/${main}/messages?limit=100`)).messages.filter((message: any) => message.automation).length).toBe(2);
    expect(messages.some((message: any) => message.role === "user" && message.text === "Synthetic human input")).toBe(true);
    evidence.push({ first: await state(one.id), second: completed, final, phoneBot, firstPidAlive: alive(firstPid), messages });
  } finally {
    const evidencePath = `${fixture.info.logPath}.background-threads.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath }));
    await new Promise<void>(resolve => sidecar.close(() => resolve()));
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);

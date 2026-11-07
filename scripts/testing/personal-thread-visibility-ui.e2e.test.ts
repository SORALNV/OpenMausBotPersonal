import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeBrowserSession } from "../../server/browser-engine.ts";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview } from "./preview-fixture.ts";

(process.env.OMB_UI_E2E === "1" ? it : it.skip)("switches explicit Personal histories in Simple mode on desktop and phone layouts", async () => {
  const tools = await ensureUiBrowser();
  const staticDir = process.env.OMB_PERSONAL_UI_DIST;
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, staticDir);
  let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
  const env = sessionEnv({ home: fixture.info.dataDir, session: "p", chrome: tools.chrome });
  const sockets = mkdtempSync("/tmp/omb-threads-");
  env.AGENT_BROWSER_SOCKET_DIR = sockets;
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args, 60000);
  const evaluate = async (js: string) => (await browser("eval", js)).result;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = fixtureApi(fixture.info.url);
  try {
    const bot = (await cli("new-bot", "--name", "RaspberryPi fixture")).bot;
    const ids: string[] = [];
    for (const title of ["Manager", "MyMCP", "MyShelf"]) {
      const threadId = ids.length ? (await api("POST", `/api/bots/${bot.id}/tasks`, { title })).task.threadId : bot.activeTaskId;
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { title });
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", `Synthetic ${title} history`);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "20")).status).toBe("settled");
      ids.push(threadId);
    }
    if (!staticDir) preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__personal_threads.html", title: "Isolated Personal threads", logLevel: "warn" });
    await browser("open", preview?.previewUrl ?? fixture.info.url);
    await evaluate("localStorage.setItem('omb-analytics-opt-out','1'); localStorage.setItem('omb-email-gate','skipped'); localStorage.setItem('omb-advanced-mode','0'); localStorage.setItem('omb-show-threads','0'); location.reload(); true");
    await expect.poll(() => evaluate(`document.querySelector('[data-sidebar-bot-row="${bot.id}"]') !== null`), { timeout: 15000 }).toBe(true);
    await evaluate(`document.querySelector('[data-sidebar-bot-row="${bot.id}"]').click(); true`);
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await browser("set", "viewport", String(width), String(height));
      for (const title of ["Manager", "MyMCP", "MyShelf"]) {
        await expect.poll(() => evaluate("document.querySelector('button[aria-label=\"All threads\"],button[aria-label=\"すべてのスレッド\"]') !== null"), { timeout: 15000 }).toBe(true);
        await evaluate("document.querySelector('button[aria-label=\"All threads\"],button[aria-label=\"すべてのスレッド\"]').click(); true");
        await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('[role=group] button')).some(e => e.querySelector('div[dir=auto]')?.textContent === ${JSON.stringify(title)})`)).toBe(true);
        await evaluate(`Array.from(document.querySelectorAll('[role=group] button')).find(e => e.querySelector('div[dir=auto]')?.textContent === ${JSON.stringify(title)}).click(); true`);
        await expect.poll(() => evaluate(`document.body.innerText.includes(${JSON.stringify(`Synthetic ${title} history`)})`), { timeout: 15000 }).toBe(true);
        expect(await evaluate("document.body.innerText.includes('仮名化して入力')")).toBe(false);
      }
      await browser("reload");
      await expect.poll(() => evaluate("document.body.innerText.includes('Synthetic MyShelf history')"), { timeout: 15000 }).toBe(true);
      await browser("screenshot", join(process.env.OMB_UI_EVIDENCE_DIR ?? fixture.info.dataDir, `threads-${width}.png`));
    }
    const { bots } = await api("GET", "/api/bots?messages=0");
    expect(bots.find((item: any) => item.id === bot.id).tasks.map((task: any) => task.threadId).sort()).toEqual([...ids].sort());
    console.info(JSON.stringify({ url: fixture.info.url, logPath: fixture.info.logPath, desktopAndNarrow: true, syntheticOnly: true }));
  } catch (error) {
    const directory = process.env.OMB_UI_EVIDENCE_DIR ?? fixture.info.dataDir;
    writeFileSync(join(directory, "ui-failure.json"), JSON.stringify(await browser("snapshot")));
    await browser("screenshot", join(directory, "ui-failure.png"));
    throw error;
  } finally {
    await closeBrowserSession(tools.binary, env);
    await preview?.close();
    await fixture.close();
    rmSync(sockets, { recursive: true, force: true });
  }
}, 180000);

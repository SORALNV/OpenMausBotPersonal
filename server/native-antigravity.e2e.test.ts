import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("keeps the conversational Bot's model, persona and OMB tools while delegating only native work and reading its result", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const root = realpathSync(dataDir), privateDir = join(root, "private"); mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const binary = join(root, "fake-native-antigravity.mjs");
  copyFileSync(fileURLToPath(new URL("../scripts/testing/fake-native-antigravity.mjs", import.meta.url)), binary); chmodSync(binary, 0o755);
  const model = "claude-sonnet-5-5-medium";
  const calls = join(root, "mediator-tools.json"); writeFileSync(calls, "[]");
  writeFileSync(join(privateDir, "native-connect.json"), JSON.stringify({ enabled: true, model, binary }), { mode: 0o600 });
  const evidence: unknown[] = [];
  let restarted: ChildProcess | undefined;
  const receipts = (): Array<{ id: string; text: string; args: string[] }> => existsSync(join(root, "native-state/receipts.jsonl"))
    ? readFileSync(join(root, "native-state/receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true); return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ args, result }); return result;
  };
  const restart = async () => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log] }); closeSync(log);
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, { timeout: 25000 }).toBe(true);
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(root, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { FAKE_CLAUDE_TOOL_CALLS_FILE: calls, FAKE_CLAUDE_REPLIES: JSON.stringify(Array(30).fill("仲介Botの短い返答です。")), FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath };
    writeFileSync(configPath, JSON.stringify(config));
    await restart();
    expect((await api("GET", "/api/instances")).instances.some((entry: any) => entry.instanceId === "antigravity-native")).toBe(false);
    for (const starter of (await api("GET", "/api/bots")).bots.filter((value: any) => value.chiefOfStaff)) await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    const bot = (await control("new-bot", "--name", "Mediator fixture")).bot;
    const thread = bot.activeTaskId ?? bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}`, { soul: "PERSONA_KEEP_ME: remain the conversational agent, keep the user's context and reply briefly." });
    await control("send", "--bot", bot.id, "--task", thread, "--text", "/allow-all");
    const turn = async (text: string) => {
      expect((await control("send", "--bot", bot.id, "--task", thread, "--text", text)).success).toBe(true);
      expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "35")).status).toBe("settled");
      return control("messages", "--bot", bot.id, "--task", thread, "--limit", "30");
    };
    const consult = await turn("NC_AGY_CONSULT: explain the approach without touching Antigravity.");
    expect(receipts()).toHaveLength(0);
    expect(consult.messages.filter((line: any) => line.role === "bot" && line.kind === "text").at(-1)?.text).toBe("仲介Botの短い返答です。");
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(launched.systemPrompt).toContain("PERSONA_KEEP_ME");
    expect(launched.systemPrompt).toContain("You remain the conversational agent");
    expect(launched.mcpConfig.mcpServers.agents.env.OMB_NATIVE_CONNECT).toBe("1");
    expect(launched.mcpConfig.mcpServers.agents).toBeDefined();
    const nativeTurn = async (prompt: string, text: string) => {
      writeFileSync(calls, JSON.stringify([{ server: "agents", name: "native_connect", input: { action: "run", prompt } }]));
      return turn(text);
    };
    const first = await nativeTurn("NC_AGY_FIRST", "Use the native harness to do the synthetic first task and summarize its result.");
    expect(receipts()).toHaveLength(1); expect(receipts()[0].text).toBe("NC_AGY_FIRST");
    expect(receipts()[0].args).toContain(model);
    expect(first.messages.some((line: any) => line.text?.startsWith("Antigravityの応答を取得しました。"))).toBe(true);
    expect(first.messages.filter((line: any) => line.role === "bot" && line.kind === "text").at(-1)?.text).toBe("仲介Botの短い返答です。");
    expect((await api("GET", "/api/bots")).bots.find((value: any) => value.id === bot.id).modelSelection).toEqual(bot.modelSelection);
    await nativeTurn("NC_AGY_SECOND", "Continue the synthetic native task.");
    expect(receipts()).toHaveLength(2); expect(receipts()[1].id).toBe(receipts()[0].id);
    await restart();
    await nativeTurn("NC_AGY_RESTART", "Continue after restarting the broker, without creating a new native conversation.");
    expect(receipts()).toHaveLength(3); expect(receipts()[2].id).toBe(receipts()[0].id);
    writeFileSync(calls, "[]"); await turn("Ordinary conversation again."); expect(receipts()).toHaveLength(3);
    const source = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(source.systemPrompt).toContain("PERSONA_KEEP_ME");
    expect((await api("GET", "/api/bots")).bots.find((value: any) => value.id === bot.id).tasks).toHaveLength(1);
    await api("PUT", "/api/native-connect", { enabled: false, model });
    await nativeTurn("NC_AGY_DISABLED", "Try the disabled native connector."); expect(receipts()).toHaveLength(3);
  } finally {
    writeFileSync(`${logPath}.native-connect.json`, JSON.stringify({ evidence }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" }); await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.native-connect.json`, realAccountUsed: false }));
  }
}, 180000);

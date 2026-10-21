#!/usr/bin/env -S node --experimental-strip-types
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const home = process.env.CODEX_HOME!;
if (!home || !home.includes("omb-direct-fixture-")) throw new Error("A sealed native fixture home is required");
mkdirSync(home, { recursive: true });
const file = join(home, "turns.json");
const read = (): any[] => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return [{ id: "baseline", status: "completed", items: [] }]; } };
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
if (process.argv[2] === "exec") {
  let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
  appendFileSync(join(home, "formatter.jsonl"), JSON.stringify({ model: process.argv[process.argv.indexOf("--model") + 1], prompt }) + "\n");
  output({ type: "item.completed", item: { type: "agent_message", text: "短縮した架空の回答" } }); output({ type: "turn.completed", usage: {} });
} else {
  createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line); if (!message.id) return;
    const { method, params } = message;
    appendFileSync(join(home, "rpc.jsonl"), JSON.stringify({ method, params }) + "\n");
    let result: unknown = {};
    if (method === "thread/read" || method === "thread/resume") result = { thread: { id: params.threadId, status: { type: "idle" } } };
    if (method === "thread/turns/list") result = { data: read().slice().reverse().slice(0, params.limit) };
    if (method === "turn/start") {
      const turn = { id: randomUUID(), status: "completed", items: [
        { id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input },
        { id: randomUUID(), type: "agentMessage", phase: "final_answer", text: "架空の元回答: " + params.input[0].text },
      ] };
      writeFileSync(file, JSON.stringify([...read(), turn]));
      output({ id: message.id, result: { turn: { id: turn.id } } });
      const finish = () => {
        if (existsSync(join(home, "hold"))) { setTimeout(finish, 25); return; }
        output({ method: "turn/completed", params: { threadId: params.threadId, turn } });
      };
      finish(); return;
    }
    output({ id: message.id, result });
  });
}

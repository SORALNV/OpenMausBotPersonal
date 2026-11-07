#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

if (process.argv.includes("models")) {
  console.log("claude-sonnet-5-5-medium  Claude Sonnet 5.5 (Medium)\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)");
  process.exit(0);
}
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const root = process.env.FAKE_AGY_DIRECTORY ?? fileURLToPath(new URL("./native-state", import.meta.url));
mkdirSync(root, { recursive: true });
const existing = process.argv.includes("--conversation") ? arg("--conversation") : undefined;
const id = existing ?? randomUUID();
const path = join(root, `${id}.json`);
const history = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
if (existing && !existsSync(path)) process.exit(3);
const send = event => process.stdout.write(`${JSON.stringify(event)}\n`);
send({ event: "init", conversation_id: id, init: { model: arg("--model") } });
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  const text = input.message.content;
  history.push(text);
  writeFileSync(path, JSON.stringify(history));
  appendFileSync(join(root, "receipts.jsonl"), `${JSON.stringify({ id, args: process.argv.slice(2), text })}\n`);
  if (text === "DISCONNECT") process.exit(3);
  if (text === "HANG") { await new Promise(() => { setInterval(() => {}, 1000); }); }
  if (text === "MISMATCH") send({ event: "step_update", step_update: { conversation_id: "wrong-session", step_type: "tool", state: "ACTIVE" } });
  if (text === "MALFORMED") process.stdout.write("not-json\n");
  if (text === "SECRET_STDERR") process.stderr.write("provider-secret-must-not-escape\n");
  if (text === "PERMISSION") process.stderr.write("permission soft-denied: command\n");
  send({ event: "step_update", step_update: { conversation_id: id, step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "read_file" } });
  send({ event: "step_update", step_update: { conversation_id: id, step_type: "thinking", text_delta: "PRIVATE_THINKING" } });
  send({ event: "step_update", step_update: { conversation_id: id, step_type: "tool", step_index: 1, state: "DONE", tool_name: "read_file" } });
  const response = `native:${arg("--model")}:${history.length}:${text.match(/NC_AGY_[A-Z0-9_]+/u)?.[0] ?? text}`;
  send({ event: "result", result: { conversation_id: id, status: text === "WAITING" ? "WAITING" : "SUCCESS", response } });
  if (text === "NONZERO") process.exit(4);
}

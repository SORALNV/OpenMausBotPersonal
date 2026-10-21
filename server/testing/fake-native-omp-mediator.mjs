#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
if (!home?.includes("omb-omp-fixture-") || process.argv[2] !== "exec") throw new Error("Synthetic mediator requires an isolated home");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(join(home, "mediator.jsonl"), JSON.stringify({ prompt }) + "\n");
const text = prompt.includes("承認判定器") ? '{"decision":"allow","importance":"low"}' : "短縮した架空の回答";
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");

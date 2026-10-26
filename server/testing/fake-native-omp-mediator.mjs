#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
if (!home?.includes("omb-omp-fixture-") || process.argv[2] !== "exec") throw new Error("Synthetic mediator requires an isolated home");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(join(home, "mediator.jsonl"), JSON.stringify({ prompt }) + "\n");
const text = prompt.includes("高リスク検出器") ? '{"highRisk":false}'
  : prompt.includes("日本語翻訳器") ? JSON.stringify({ question: "架空の項目を選んでください", options: prompt.includes("Choose a fixture") ? ["アルファ", "ベータ"] : [] })
  : prompt.includes("セッション管理ルーター") ? (() => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    if (input.user_request.includes("FIXTURE_CREATE_AND_LINK")) return JSON.stringify({ action: "create", name: "架空の研究プロジェクト", destination: "new-thread", newThreadRequest: input.user_request });
    if (input.user_request.includes("FIXTURE_CREATE_ONLY")) return JSON.stringify({ action: "create", name: "架空の保存専用", destination: "none" });
    if (input.user_request.includes("FIXTURE_BAD_SESSION_PLAN")) return "invalid-plan";
    return JSON.stringify({ action: "chat", note: "短縮した架空の回答" });
  })()
  : "短縮した架空の回答";
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");

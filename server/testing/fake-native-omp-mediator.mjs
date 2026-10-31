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
  : prompt.includes("OMB内の設定・連携を扱う管理担当") ? (() => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    if (!input.results.length) return JSON.stringify(input.user_request.includes("FIXTURE_OMB_PROFILE") ? { tool: "propose_profile", arguments: { description: "架空のNAS管理担当", reason: "本人が依頼した説明の変更" } } : { tool: "list_triggers", arguments: {} });
    return JSON.stringify({ answer: "OMB管理APIの結果を確認しました。変更の確認が必要な場合はカードで確認できます。" });
  })()
  : prompt.includes("セッション管理ルーター") ? (() => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    if (input.user_request.includes("FIXTURE_PROJECT_INVALID")) return JSON.stringify({ action: "chat", steps: [{ sessionQuery: "unknown", request: "架空の確認" }] });
    if (input.user_request.includes("FIXTURE_PROJECT_CROSS")) return JSON.stringify({ action: "chat", steps: input.projects.map(project => ({ sessionQuery: project.sessionId, request: project.name + "の担当分だけを確認" })) });
    if (input.user_request.includes("FIXTURE_LOCAL_ADVICE")) return JSON.stringify({ action: "reply", answer: "相談として説明します。実機は確認していません。" });
    if (input.user_request.includes("FIXTURE_OMB_LOCAL") || input.user_request.includes("FIXTURE_OMB_PROFILE")) return JSON.stringify({ action: "omb", note: "OMBの設定を確認" });
    if (input.user_request.includes("FIXTURE_CREATE_AND_LINK")) return JSON.stringify({ action: "create", name: "架空の研究プロジェクト", destination: "new-thread", newThreadRequest: input.user_request });
    if (input.user_request.includes("FIXTURE_CREATE_ONLY")) return JSON.stringify({ action: "create", name: "架空の保存専用", destination: "none" });
    if (input.user_request.includes("FIXTURE_BAD_SESSION_PLAN")) return "invalid-plan";
    if (input.mode === "router") return JSON.stringify({ action: "chat", sessionQuery: "omb-7312f6e096a604067beb75180eadc322", note: "架空の既存セッションを選択" });
    return JSON.stringify({ action: "chat", note: "短縮した架空の回答" });
  })()
  : "短縮した架空の回答";
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");

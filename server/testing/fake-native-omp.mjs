import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = process.env.FAKE_CLAUDE_OMP_ROOT;
if (!root || !process.env.HOME?.includes("omb-omp-fixture-")) throw new Error("Synthetic native peer requires an isolated home");
mkdirSync(root, { recursive: true });
const sessionDir = process.argv[2];
const sessionId = createHash("sha256").update(sessionDir).digest("hex");
const sessionFile = `${sessionDir}/synthetic.jsonl`;
const historyFile = join(root, `${sessionId}.json`);
const testSource = "import unittest\nclass T(unittest.TestCase):\n def test_value(self): self.assertEqual(1, 1)\n";
const output = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const answer = frame => {
  const history = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, "utf8")) : [];
  history.push(frame.message); writeFileSync(historyFile, JSON.stringify(history));
  output({ type: "message_end", messageId: frame.id, message: { role: "assistant", content: [{ type: "text", text: "架空の元回答: " + frame.message }], stopReason: "stop" } });
  output({ type: "prompt_result", id: frame.id, status: "completed", sessionSettled: true });
};
let active;
const lines = createInterface({ input: process.stdin });
output({ type: "ready", supportedProtocolVersions: [1, 2] });
lines.on("line", line => {
  const frame = JSON.parse(line);
  appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ ...frame, sessionDir }) + "\n");
  if (frame.type === "negotiate_protocol") output({ type: "response", id: frame.id, command: frame.type, success: true, data: {} });
  if (frame.type === "open_session") output({ type: "response", id: frame.id, command: frame.type, success: true, data: { sessionId, sessionFile, resumed: existsSync(historyFile), cancelled: false } });
  if (frame.type === "prompt") {
    active = frame;
    output({ type: "response", id: frame.id, command: "prompt", success: true });
    if (frame.message.includes("SYNTHETIC_REVIEW_PROJECT")) output({ type: "extension_ui_request", id: "fixture-project", method: "select", title: "Allow tool: write", message: "Allow tool: write\nPath: tests/test_fixture.py\nContent: " + testSource, options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_TEST")) output({ type: "extension_ui_request", id: "fixture-test", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: .venv/bin/python -m unittest discover -s tests -v", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_SMOKE")) output({ type: "extension_ui_request", id: "fixture-smoke", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: .venv/bin/python _smoke_fixture.py", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_EDIT")) output({ type: "extension_ui_request", id: "fixture-edit", method: "select", title: "Allow tool: edit\nFile: tests/test_fixture.py", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_CONFIG")) output({ type: "extension_ui_request", id: "fixture-config", method: "select", title: "Allow tool: write\nPath: .mcp.json\nContent: {}", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_STATUS")) output({ type: "extension_ui_request", id: "fixture-status", method: "select", title: "Allow tool: bash\nCommand: curl --silent http://127.0.0.1:8081/api/wol/status", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_DIAGNOSTIC")) output({ type: "extension_ui_request", id: "fixture-diagnostic", method: "select", title: "Allow tool: bash\nCommand: python3 -c \"print(1)\"", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_LOOKUP")) output({ type: "extension_ui_request", id: "fixture-lookup", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: command -v omp omb", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_INSPECTION")) output({ type: "extension_ui_request", id: "fixture-permission", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: lsblk -o NAME,SIZE", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_IMPORTANT")) output({ type: "extension_ui_request", id: "fixture-permission", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: mkfs.ext4 /dev/sda", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_SELECT_APPROVAL")) output({ type: "extension_ui_request", id: "fixture-permission", method: "select", title: "Allow tool: write\nPath: /fixture/synthetic.txt", options: ["Approve", "Approve write for this session", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_APPROVAL")) output({ type: "extension_ui_request", id: "fixture-permission", method: "confirm", title: "Synthetic permission", message: "Create a fixture-only marker?" });
    else if (frame.message.includes("SYNTHETIC_QUESTION")) output({ type: "extension_ui_request", id: "fixture-question", method: "select", title: "Choose a fixture", options: ["Alpha", "Beta"] });
    else if (frame.message.includes("SYNTHETIC_REPORT")) output({ type: "extension_ui_request", id: "fixture-report", method: "select", title: "👻 Your agent swears one of its tools is haunted.\nCall in the devs for an exorcism? Tool name + the spooky bit, nothing personal.", options: ["Yes", "No"] });
    else if (frame.message.includes("SYNTHETIC_PROGRESS")) {
      output({ type: "tool_execution_start", toolName: "read", toolCallId: "progress-read" });
      output({ type: "message_end", messageId: "progress-commentary", message: { role: "assistant", content: [{ type: "thinking", thinking: "SYNTHETIC_PRIVATE_REASONING" }, { type: "text", text: "架空の設定を確認しました。続いてテストします。" }], stopReason: "toolUse" } });
      setTimeout(() => output({ type: "tool_execution_end", toolName: "read", toolCallId: "progress-read", isError: false }), 200);
      setTimeout(() => answer(frame), 500);
    }
    else if (frame.message.includes("SYNTHETIC_HOLD")) { /* Abort is the only synthetic completion. */ }
    else if (frame.message.includes("SYNTHETIC_FAILURE")) output({ type: "prompt_result", id: frame.id, status: "error", sessionSettled: true });
    else answer(frame);
  }
  if (frame.type === "extension_ui_response") {
    if (frame.confirmed === true || frame.value === "Approve") {
      if (frame.id === "fixture-project") writeFileSync(join(root, `review-writes-${sessionId}.json`), JSON.stringify([{ path: "tests/test_fixture.py", content: testSource }, { path: "_smoke_fixture.py", content: "assert 1 == 1\n" }]));
      writeFileSync(join(root, "approved-marker"), "synthetic");
      output({ type: "tool_execution_start", toolName: "write", toolCallId: "fixture-write" });
      output({ type: "tool_execution_end", toolName: "write", toolCallId: "fixture-write", isError: false });
    }
    answer({ ...active, message: `${active.message}\nhuman:${JSON.stringify(frame)}` });
  }
  if (frame.type === "abort" && active) output({ type: "prompt_result", id: active.id, status: "aborted", sessionSettled: true });
});

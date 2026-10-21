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
const output = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const answer = frame => {
  const history = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, "utf8")) : [];
  history.push(frame.message); writeFileSync(historyFile, JSON.stringify(history));
  output({ type: "message_end", messageId: frame.id, message: { role: "assistant", content: [{ type: "text", text: "架空の元回答: " + frame.message }] } });
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
    if (frame.message.includes("SYNTHETIC_REVIEW_INSPECTION")) output({ type: "extension_ui_request", id: "fixture-permission", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: lsblk -o NAME,SIZE", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_REVIEW_IMPORTANT")) output({ type: "extension_ui_request", id: "fixture-permission", method: "select", title: "Allow tool: bash", message: "Allow tool: bash\nCommand: mkfs.ext4 /dev/sda", options: ["Approve", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_SELECT_APPROVAL")) output({ type: "extension_ui_request", id: "fixture-permission", method: "select", title: "Allow tool: write\nPath: /fixture/synthetic.txt", options: ["Approve", "Approve write for this session", "Deny"] });
    else if (frame.message.includes("SYNTHETIC_APPROVAL")) output({ type: "extension_ui_request", id: "fixture-permission", method: "confirm", title: "Synthetic permission", message: "Create a fixture-only marker?" });
    else if (frame.message.includes("SYNTHETIC_QUESTION")) output({ type: "extension_ui_request", id: "fixture-question", method: "select", title: "Choose a fixture", options: ["Alpha", "Beta"] });
    else if (frame.message.includes("SYNTHETIC_HOLD")) { /* Abort is the only synthetic completion. */ }
    else if (frame.message.includes("SYNTHETIC_FAILURE")) output({ type: "prompt_result", id: frame.id, status: "error", sessionSettled: true });
    else answer(frame);
  }
  if (frame.type === "extension_ui_response") {
    if (frame.confirmed === true || frame.value === "Approve") {
      writeFileSync(join(root, "approved-marker"), "synthetic");
      output({ type: "tool_execution_start", toolName: "write", toolCallId: "fixture-write" });
      output({ type: "tool_execution_end", toolName: "write", toolCallId: "fixture-write", isError: false });
    }
    answer({ ...active, message: `${active.message}\nhuman:${JSON.stringify(frame)}` });
  }
  if (frame.type === "abort" && active) output({ type: "prompt_result", id: active.id, status: "aborted", sessionSettled: true });
});

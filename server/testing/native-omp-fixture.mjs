import { spawn } from "node:child_process";
import { NativeOmpTransport, nativeOmpCommand } from "../../scripts/native-omp-transport.mjs";
import { NativeOmpCollab } from "../../scripts/native-omp-collab.mjs";
import { NativeOmpPool } from "../../scripts/native-omp-pool.mjs";
import { NativeOmpCatalog } from "../../scripts/native-omp-catalog.mjs";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

if (!process.env.FAKE_CLAUDE_OMP_ROOT || !process.env.HOME?.includes("omb-omp-fixture-")) throw new Error("Native fixture requires an isolated home");
NativeOmpTransport.connect = binding => {
  const plan = nativeOmpCommand(binding);
  const client = new NativeOmpTransport(spawn(process.execPath, [new URL("./fake-native-omp.mjs", import.meta.url).pathname, plan.sessionDir],
    { stdio: ["pipe", "pipe", "pipe"], env: { HOME: process.env.HOME, FAKE_CLAUDE_OMP_ROOT: process.env.FAKE_CLAUDE_OMP_ROOT } }), plan.sessionDir, { timeoutMs: 1000, turnTimeoutMs: 20_000 });
  const writes = join(process.env.FAKE_CLAUDE_OMP_ROOT, `review-writes-${createHash("sha256").update(plan.sessionDir).digest("hex")}.json`);
  client.recentFileWrites = () => existsSync(writes) ? JSON.parse(readFileSync(writes, "utf8")) : [];
  client.reviewFiles = async () => client.recentFileWrites();
  client.pendingOperation = question => question.title === "Allow tool: edit\nFile: tests/test_fixture.py" ? { name: "edit", arguments: { input: "*** Begin Patch\n[tests/test_fixture.py#1234]\nPUT >1:\n+assert True\n*** End Patch" } } : undefined;
  return client;
};
NativeOmpCollab.connect = NativeOmpTransport.connect;
NativeOmpPool.prototype.acquire = NativeOmpTransport.connect;
NativeOmpCatalog.prototype.run = async (binding, action, input) => {
  const file = join(process.env.FAKE_CLAUDE_OMP_ROOT, "sessions.json");
  const sessions = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  if (action === "list") return { sessions };
  const previous = sessions.find(session => session.operationId === input.operationId);
  if (previous) return { session: previous };
  const sessionDir = `${binding.stateRoot}/projects/${input.operationId}`;
  const session = { id: createHash("sha256").update(sessionDir).digest("hex"), operationId: input.operationId, name: input.name, directory: sessionDir, file: `${sessionDir}/synthetic.jsonl`, running: false, shared: false };
  sessions.push(session); writeFileSync(file, JSON.stringify(sessions));
  appendFileSync(join(process.env.FAKE_CLAUDE_OMP_ROOT, "session-operations.jsonl"), JSON.stringify({ action, id: session.id }) + "\n");
  return { session };
};

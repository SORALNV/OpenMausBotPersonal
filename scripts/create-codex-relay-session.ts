import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { openNativeCodex } from "../server/direct-codex-formatter.ts";
import { createRelaySession } from "../server/codex-relay-session.ts";

const { values } = parseArgs({ options: { source: { type: "string" }, name: { type: "string" }, report: { type: "string" } }, strict: true });
if (!values.source || !values.name || !values.report) throw new Error("Usage: node scripts/create-codex-relay-session.ts --source THREAD_ID --name NAME --report NEW_REPORT_PATH");
const receipt: Record<string, unknown> = { createdAt: new Date().toISOString(), sourceThreadId: values.source, name: values.name, state: "started", automaticRetryAllowed: false };
writeFileSync(values.report, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
const client = await openNativeCodex();
try {
  Object.assign(receipt, await createRelaySession(client, values.source, values.name), { state: "created", originalUnchanged: true, laterHistoryShared: false });
  console.log(JSON.stringify(receipt));
} catch (error) {
  Object.assign(receipt, { state: "uncertain", error: error instanceof Error ? error.message : "Native operation failed" });
  process.exitCode = 1;
} finally { await client.close(); writeFileSync(values.report, JSON.stringify(receipt, null, 2), { mode: 0o600 }); }

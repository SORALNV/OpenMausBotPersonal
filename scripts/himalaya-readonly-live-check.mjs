import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runReadOnly } from "./himalaya-readonly.mjs";

const { values } = parseArgs({ options: { binary: { type: "string" }, config: { type: "string" } } });
const config = values.config ?? join(homedir(), ".config/himalaya-security-test/config.toml");
const root = realpathSync(mkdtempSync(join(tmpdir(), "himalaya-readonly-live-")));
const options = { config, ...(values.binary ? { binary: values.binary } : {}), stateDir: join(root, "monitor") };
const configuration = () => {
  const stat = lstatSync(config);
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode];
};
const original = configuration();
const summary = result => ({
  complete: result.complete,
  entries: result.entries.length,
  accounts: result.accounts.map(account => ({
    account: account.account, complete: account.complete, scanned: account.scanned, matched: account.matched,
    since: account.since, as_of: account.as_of, deferred: account.deferred,
    resumable: Boolean(account.next_cursor), error: account.error?.code,
  })),
});
const run = argv => runReadOnly(argv, options);
const fingerprint = result => createHash("sha256").update(JSON.stringify(result)).digest("hex");
const emit = (check, value) => process.stdout.write(JSON.stringify({ check, ...value }) + "\n");
let phase = "accounts";

try {
  const accounts = (await run(["accounts"])).accounts;
  assert.ok(accounts.length > 0 && accounts.every(account => account.backends.includes("imap")));
  for (const since of ["30m", "6h"]) {
    phase = `inbox_${since}`;
    const started = performance.now();
    const result = await run(["inbox", "--since", since, "--page-size", "100", "--max-pages", "100"]);
    emit(`inbox_${since}`, { duration_ms: Math.round(performance.now() - started), output_bytes: Buffer.byteLength(JSON.stringify(result)) + 1, ...summary(result) });
    assert.equal(result.complete, true);
    assert.equal(result.accounts.length, accounts.length);
  }
  for (const { name: account } of accounts) {
    phase = `monitor_${account}`;
    const args = ["monitor", "--account", account, "--since", "6h", "--page-size", "5", "--max-pages", "1"];
    const started = performance.now();
    let result = await run(args);
    assert.ok(!result.accounts[0].error);
    const repeated = await run(args);
    assert.equal(fingerprint(repeated), fingerprint(result));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { runReadOnly } from ${JSON.stringify(new URL("./himalaya-readonly.mjs", import.meta.url).href)};
      import { createHash } from "node:crypto";
      try {
        const value = await runReadOnly(${JSON.stringify(args)}, ${JSON.stringify(options)});
        process.stdout.write(JSON.stringify({ fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex") }));
      } catch { process.exitCode = 1; }
    `], { encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
    assert.equal(child.status, 0);
    assert.equal(JSON.parse(child.stdout).fingerprint, fingerprint(result));
    let batches = 0, scanned = 0, matched = 0;
    const ids = new Set();
    while (true) {
      const coverage = result.accounts[0];
      assert.ok(!coverage.error);
      assert.equal(coverage.deferred, false);
      const { batch_id: batchId, next_cursor: nextCursor } = coverage;
      assert.ok(batchId);
      for (const entry of result.entries) {
        const key = JSON.stringify([entry.account, entry.mailbox, coverage.uid_validity, entry.envelope.id]);
        assert.ok(!ids.has(key));
        ids.add(key);
      }
      scanned += coverage.scanned;
      matched += result.entries.length;
      const ack = ["monitor", "--account", account, "--since", "6h", "--ack", batchId];
      assert.equal((await run(ack)).accounts[0].acknowledged, batchId);
      assert.equal((await run(ack)).accounts[0].acknowledged, batchId);
      batches += 1;
      if (coverage.complete) break;
      assert.ok(nextCursor && batches < 30);
      result = await run(args);
      assert.equal(result.accounts[0].cursor, nextCursor);
    }
    const delta = await run(args);
    assert.ok(!delta.accounts[0].error);
    emit("monitor_resume_ack_restart_delta", { account, batches, scanned, matched, replay_same: true, restart_same: true, duplicate_ids: 0, duration_ms: Math.round(performance.now() - started), delta: summary(delta) });
    assert.ok(delta.accounts[0].batch_id);
    const deltaAck = await run(["monitor", "--account", account, "--since", "6h", "--ack", delta.accounts[0].batch_id]);
    assert.equal(deltaAck.complete, true);
    assert.equal(deltaAck.accounts[0].acknowledged, delta.accounts[0].batch_id);
  }
  const files = readdirSync(options.stateDir);
  assert.ok(files.every(file => file.endsWith(".json")));
  assert.equal(lstatSync(options.stateDir).mode & 0o777, 0o700);
  for (const name of files) {
    const path = join(options.stateDir, name);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    const serialized = readFileSync(path, "utf8");
    assert.ok(!/"(?:entries|envelope|subject|password|from|to|body)"\s*:/u.test(serialized));
  }
  assert.deepEqual(configuration(), original);
  emit("private_metadata_config_preserved", { accounts: accounts.length, private_state_files: files.length, config_unchanged: true, persisted_mail_content: false });
} catch {
  emit("verification_failed", { complete: false, phase });
  process.exitCode = 1;
} finally {
  if (root.startsWith(realpathSync(tmpdir()) + "/himalaya-readonly-live-")) rmSync(root, { recursive: true });
}

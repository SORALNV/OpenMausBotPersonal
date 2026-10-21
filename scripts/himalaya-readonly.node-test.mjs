import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeRead, ReadError, readCommand, runReadOnly } from "./himalaya-readonly.mjs";

test("recent inbox supports every account and a selected account", () => {
  const all = readCommand(["inbox", "--since", "30m"], "/fixture/config.toml");
  assert.ok(!all.some(value => value.startsWith("--account")));
  assert.deepEqual(all.slice(5), ["inbox", "scan", "--since", "30m", "--page-size", "25", "--max-pages", "4", "--max-bytes", "131072"]);
  const one = readCommand(["inbox", "--account", "alpha", "--since", "2h"]);
  assert.ok(one.includes("--account=alpha"));
});

test("flags cannot turn data into commands", () => {
  const args = readCommand(["read", "--account=--log-level=trace", "--mailbox", "INBOX; touch nope", "--id=--seen"]);
  assert.ok(args.includes("--account=--log-level=trace"));
  assert.ok(args.includes("--mailbox=INBOX; touch nope"));
  assert.deepEqual(args.slice(-2), ["--", "--seen"]);
});

test("writes and arbitrary commands are rejected", () => {
  for (const operation of ["send", "delete", "move", "configure", "flag", "attachment", "raw", "__proto__"]) {
    assert.throws(() => readCommand([operation]));
  }
  assert.throws(() => readCommand(["read", "--account", "a", "--id", "1", "--seen"]));
  assert.throws(() => readCommand(["inbox", "--config", "/other"]));
  assert.throws(() => readCommand(["accounts", "message", "send"]));
});

test("single-account operations never silently use a default", () => {
  for (const operation of ["read", "list", "search", "mailboxes"]) assert.throws(() => readCommand([operation]));
});

test("bounds and receipt windows are validated", () => {
  for (const value of ["0", "101", "-1", "1e4"]) assert.throws(() => readCommand(["inbox", "--max-pages", value]));
  for (const value of ["0m", "-1h", "１時間", "1y"]) assert.throws(() => readCommand(["inbox", "--since", value]));
  assert.throws(() => readCommand(["inbox", "--since", "30m", "--all-time"]));
  assert.ok(readCommand(["inbox", "--all-time"]).includes("--all-time"));
});

test("query and ID are required, bounded data", () => {
  assert.throws(() => readCommand(["read", "--account", "a"]));
  assert.throws(() => readCommand(["search", "--account", "a"]));
  assert.throws(() => readCommand(["read", "--account", "a", "--id", "1\n2"]));
  assert.deepEqual(readCommand(["search", "--account", "a", "--query", "subject 請求"]).slice(-2), ["--", "subject 請求"]);
});

test("private config and incomplete coverage remain intact", async context => {
  const root = mkdtempSync(join(tmpdir(), "himalaya-wrapper-test-"));
  context.after(() => rmSync(root, { recursive: true }));
  const config = join(root, "config.toml");
  writeFileSync(config, "[accounts.fixture]\n", { mode: 0o600 });
  const data = { complete: false, entries: [], accounts: [{ account: "alpha", error: null, exhausted: false, missing_received_at: 0, repeated_ids: 0 }] };
  const execute = async () => data;
  assert.equal((await runReadOnly(["inbox", "--account", "alpha"], { config, execute })).complete, false);
  chmodSync(config, 0o644);
  await assert.rejects(runReadOnly(["accounts"], { config, execute }));
});

test("subprocess failures and malformed output do not expose diagnostics", async () => {
  await assert.rejects(executeRead(process.execPath, ["-e", "console.error('FAKE_SECRET_DIAGNOSTIC'); process.exit(1)"]), error => !error.message.includes("FAKE_SECRET_DIAGNOSTIC"));
  await assert.rejects(executeRead(process.execPath, ["-e", "console.log('FAKE_NON_JSON_SECRET')"]), error => !error.message.includes("FAKE_NON_JSON_SECRET"));
  assert.deepEqual(await executeRead(process.execPath, ["-e", 'console.log(JSON.stringify({ok:true}))']), { ok: true });
});

test("real fork reads synthetic Maildir through the wrapper without marking seen", async context => {
  const binary = new URL("../../himalaya/target/debug/himalaya", import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), "himalaya-wrapper-maildir-"));
  context.after(() => rmSync(root, { recursive: true }));
  const config = join(root, "config.toml");
  for (const account of ["alpha", "beta"]) {
    for (const folder of ["cur", "new", "tmp"]) mkdirSync(join(root, account, "inbox", folder), { recursive: true });
    writeFileSync(join(root, account, "inbox/new/fixture"), "From: fixture@example.test\r\nSubject: fixture\r\nDate: Fri, 16 Oct 2026 00:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nSynthetic mail only\r\n");
  }
  writeFileSync(config, ["alpha", "beta"].map(account => `[accounts.${account}]\nmaildir.root = ${JSON.stringify(join(root, account))}\n`).join("\n"), { mode: 0o600 });
  const run = argv => runReadOnly(argv, { binary, config });
  assert.equal((await run(["accounts"])).accounts.length, 2);
  assert.equal((await run(["mailboxes", "--account", "alpha"])).mailboxes.length, 1);
  const all = await run(["inbox", "--all-time"]);
  assert.equal(all.complete, true);
  assert.equal(all.entries.length, 2);
  const recent = await run(["inbox", "--since", "30m"]);
  assert.equal(recent.complete, false);
  assert.equal(recent.entries.length, 0);
  assert.ok(recent.accounts.every(account => account.error.code === "UNSUPPORTED_BACKEND"));
  const list = await run(["list", "--account", "alpha", "--mailbox", "inbox"]);
  assert.equal(list.envelopes.length, 1);
  const message = await run(["read", "--account", "alpha", "--mailbox", "inbox", "--id", list.envelopes[0].id]);
  assert.ok(message.text.includes("Synthetic mail only"));
  assert.ok(existsSync(join(root, "alpha/inbox/new/fixture")));
  const searched = await run(["search", "--account", "alpha", "--query", "subject fixture"]);
  assert.equal(searched.envelopes.length, 1);
});

const AS_OF = "2026-10-18T12:00:00Z";
const SINCE = "2026-10-18T11:30:00Z";
function batch(account = "alpha", overrides = {}) {
  return { version: 1, account, mailbox: "INBOX", since: SINCE, as_of: AS_OF,
    complete: false, deferred: false, scanned: 1, matched: 1, uid_validity: 123, snapshot_uid: 20,
    cursor: "snapshot-start", next_cursor: "snapshot-next", checkpoint: null, reason: "PAGE_LIMIT",
    entries: [{ account, mailbox: "INBOX", received_at: "2026-10-18T11:50:00Z", envelope: { id: "19", subject: "SYNTHETIC_SUBJECT_ONLY" } }], ...overrides };
}
function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "himalaya-wrapper-fixture-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config.toml"), stateDir = join(root, "monitor");
  writeFileSync(config, "[accounts.alpha]\n# SYNTHETIC_CONFIG_SECRET\n", { mode: 0o600 });
  const calls = [];
  let responder = async command => command.includes("account") ? { accounts: [{ name: "alpha" }, { name: "beta" }] } : batch(argument(command, "account"));
  const options = { config, stateDir, execute: async (binary, command, limits) => { calls.push({ command, limits }); return responder(command, limits); } };
  return { root, config, stateDir, calls, options,
    respond: callback => { responder = callback; },
    run: (argv = ["monitor", "--account", "alpha"], extra = {}) => runReadOnly(argv, { ...options, ...extra }),
    statePath: () => join(stateDir, readdirSync(stateDir).find(name => name.endsWith(".json"))),
  };
}
function argument(command, name) {
  const attached = command.find(item => item.startsWith(`--${name}=`));
  if (attached) return attached.slice(name.length + 3);
  const index = command.indexOf(`--${name}`);
  return index === -1 ? undefined : command[index + 1];
}
function errorCode(result, code, index = 0) {
  assert.equal(result.complete, false);
  assert.equal(result.accounts[index].error.code, code);
}

test("scan arguments are bounded, explicit and unambiguous", () => {
  for (const argv of [
    ["inbox", "--cursor", "abc"], ["inbox", "--after", "abc"],
    ["inbox", "--account", "alpha", "--cursor", "a", "--after", "b"],
    ["inbox", "--account", "alpha", "--cursor", "a".repeat(16_385)],
    ["inbox", "--since", "30m", "--since", "1h"],
    ["inbox", "--max-bytes", "131073"], ["inbox", "--max-bytes", "8191"], ["inbox", "--as-of", "yesterday"],
    ["monitor", "--account", "alpha", "--cursor", "a"],
    ["monitor", "--ack", "01234567-0123-0123-0123-012345678901"],
    ["inbox", "--max-pages", "101"],
  ]) assert.throws(() => readCommand(argv), { code: "ARGUMENT" });
  const command = readCommand(["inbox", "--account", "alpha", "--cursor=--log-level=trace", "--page-size", "100", "--as-of", AS_OF]);
  assert.ok(command.includes("scan"));
  assert.equal(argument(command, "page-size"), "50");
  assert.equal(argument(command, "cursor"), "--log-level=trace");
  assert.equal(argument(command, "as-of"), AS_OF);
});

test("each account gets its own bounded scan and a failing account does not discard successes", async context => {
  const f = fixture(context);
  f.respond(async command => {
    if (command.includes("account")) return { accounts: [{ name: "broken" }, { name: "alpha" }, { name: "beta" }] };
    const account = argument(command, "account");
    if (account === "broken") throw new ReadError("TIMEOUT", { duration_ms: 12, stderr_bytes: 9, stdout_bytes: 0, exit_code: null, signal: "SIGKILL", secret: "SYNTHETIC_SECRET" });
    return batch(account, account === "beta" ? { complete: true, next_cursor: null, checkpoint: "done", reason: null } : {});
  });
  const result = await f.run(["inbox", "--since", "30m", "--page-size", "100", "--max-pages", "100"]);
  errorCode(result, "TIMEOUT");
  assert.equal(result.entries.length, 2);
  assert.equal(result.accounts[1].next_cursor, "snapshot-next");
  assert.equal(result.accounts[2].checkpoint, "done");
  assert.equal(f.calls.length, 4);
  for (const call of f.calls.slice(1)) {
    assert.ok(call.command.includes("scan"));
    assert.ok(argument(call.command, "account"));
    assert.equal(argument(call.command, "page-size"), "50");
    assert.equal(argument(call.command, "max-pages"), "4");
    assert.equal(argument(call.command, "as-of"), undefined);
    assert.ok(call.limits.timeoutMs <= 12_000);
    assert.ok(call.limits.maxBytes <= 131_072);
  }
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
  assert.equal(existsSync(f.stateDir), false);
});

test("ordinary cursor and after queries do not create or consume monitor state", async context => {
  const f = fixture(context);
  await f.run();
  const original = readFileSync(f.statePath(), "utf8");
  for (const flag of ["cursor", "after"]) {
    await f.run(["inbox", "--account", "alpha", `--${flag}`, "external-token"]);
    assert.equal(argument(f.calls.at(-1).command, flag), "external-token");
    assert.equal(readFileSync(f.statePath(), "utf8"), original);
  }
});

test("monitor replays the exact batch until ack, then resumes the partial snapshot", async context => {
  const f = fixture(context);
  const first = await f.run();
  const id = first.accounts[0].batch_id;
  assert.equal(argument(f.calls[0].command, "as-of"), undefined);
  const firstState = JSON.parse(readFileSync(f.statePath(), "utf8"));
  assert.equal(firstState.resume, null);
  assert.equal(firstState.pending.cursor, "snapshot-start");
  assert.equal(firstState.pending.advance.token, "snapshot-next");
  const replay = await f.run(["monitor", "--account", "alpha", "--page-size", "50", "--max-bytes", "8192"]);
  assert.equal(replay.accounts[0].batch_id, id);
  assert.equal(argument(f.calls.at(-1).command, "cursor"), "snapshot-start");
  assert.equal(argument(f.calls.at(-1).command, "as-of"), AS_OF);
  assert.equal(argument(f.calls.at(-1).command, "page-size"), "25");
  assert.equal(argument(f.calls.at(-1).command, "max-bytes"), "131072");
  assert.deepEqual(replay.entries, first.entries);
  const beforeAck = f.calls.length;
  const ack = ["monitor", "--account", "alpha", "--ack", id];
  assert.equal((await f.run(ack)).accounts[0].acknowledged, id);
  assert.equal((await f.run(ack)).accounts[0].acknowledged, id);
  assert.equal(f.calls.length, beforeAck);
  const saved = JSON.parse(readFileSync(f.statePath(), "utf8"));
  assert.deepEqual(saved.resume, { kind: "cursor", token: "snapshot-next" });
  assert.equal(saved.pending, null);
  f.respond(async command => {
    assert.equal(argument(command, "cursor"), "snapshot-next");
    return batch("alpha", { cursor: "snapshot-next", complete: true, next_cursor: null, checkpoint: "completed-checkpoint", reason: null });
  });
  const next = await f.run();
  assert.notEqual(next.accounts[0].batch_id, id);
  assert.equal(next.complete, true);
  await f.run(ack);
  assert.equal(JSON.parse(readFileSync(f.statePath(), "utf8")).pending.batch_id, next.accounts[0].batch_id);
  await f.run(["monitor", "--account", "alpha", "--ack", next.accounts[0].batch_id]);
  f.respond(async command => {
    assert.equal(argument(command, "after"), "completed-checkpoint");
    assert.equal(argument(command, "cursor"), undefined);
    assert.equal(argument(command, "since"), "30m");
    assert.equal(argument(command, "as-of"), undefined);
    return batch("alpha", { cursor: "fresh-start" });
  });
  await f.run();
});

test("pending state survives an exited process before downstream handling", async context => {
  const f = fixture(context);
  const moduleURL = new URL("./himalaya-readonly.mjs", import.meta.url).href;
  const script = `import { runReadOnly } from ${JSON.stringify(moduleURL)}; await runReadOnly(['monitor','--account','alpha'], {config:${JSON.stringify(f.config)},stateDir:${JSON.stringify(f.stateDir)},execute:async()=>(${JSON.stringify(batch())})}); process.exit(17);`;
  await assert.rejects(executeRead(process.execPath, ["--input-type=module", "-e", script]), { code: "PROCESS_EXIT" });
  const pending = JSON.parse(readFileSync(f.statePath(), "utf8")).pending;
  const replay = await f.run();
  assert.equal(replay.accounts[0].batch_id, pending.batch_id);
  assert.equal(argument(f.calls.at(-1).command, "cursor"), pending.cursor);
  assert.equal(JSON.parse(readFileSync(f.statePath(), "utf8")).resume, null);
});

test("failures, wrong ack, changed UIDVALIDITY and replay mismatch never advance state", async context => {
  const f = fixture(context);
  const first = await f.run();
  const original = readFileSync(f.statePath(), "utf8");
  errorCode(await f.run(["monitor", "--account", "alpha", "--ack", "00000000-0000-0000-0000-000000000000"]), "ACK_MISMATCH");
  for (const code of ["UIDVALIDITY_CHANGED", "INVALID_CURSOR", "CURSOR_SCOPE_CHANGED", "UNSUPPORTED_BACKEND", "SCAN_FAILED", "ACCOUNT_REQUIRED", "CONFIG_ERROR", "MISSING_UID_METADATA", "UID_STATE_REGRESSED", "INVALID_UID_RESPONSE"]) {
    f.respond(async () => ({ version: 1, account: "alpha", complete: false, error: { code, message: "SYNTHETIC_SECRET" }, entries: [] }));
    const failed = await f.run();
    errorCode(failed, code);
    assert.ok(!JSON.stringify(failed).includes("SYNTHETIC_SECRET"));
    assert.equal(readFileSync(f.statePath(), "utf8"), original);
  }
  f.respond(async () => { throw new Error("SYNTHETIC_SECRET"); });
  errorCode(await f.run(), "PROCESS_EXIT");
  f.respond(async () => batch("alpha", { next_cursor: "different" }));
  errorCode(await f.run(), "REPLAY_CHANGED");
  f.respond(async () => batch("alpha", { entries: [], matched: 0 }));
  errorCode(await f.run(), "REPLAY_CHANGED");
  assert.equal(readFileSync(f.statePath(), "utf8"), original);
  assert.ok(first.accounts[0].batch_id);
});

test("oversized entry with no cursor progress stays incomplete across explicit ack", async context => {
  const f = fixture(context);
  f.respond(async () => batch("alpha", { entries: [], scanned: 0, matched: 0, next_cursor: "snapshot-start", reason: "ENTRY_TOO_LARGE" }));
  const result = await f.run();
  assert.equal(result.complete, false);
  assert.equal(result.accounts[0].reason, "ENTRY_TOO_LARGE");
  await f.run(["monitor", "--account", "alpha", "--ack", result.accounts[0].batch_id]);
  assert.equal((await f.run()).complete, false);
  assert.equal(argument(f.calls.at(-1).command, "cursor"), "snapshot-start");
});

test("monitor disk contents are private metadata only, with no mail or configuration contents", async context => {
  const f = fixture(context);
  await f.run();
  assert.equal(lstatSync(f.stateDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.statePath()).mode & 0o777, 0o600);
  const persisted = readFileSync(f.statePath(), "utf8");
  assert.ok(!persisted.includes("SYNTHETIC_SUBJECT_ONLY"));
  assert.ok(!persisted.includes("SYNTHETIC_CONFIG_SECRET"));
  assert.ok(!persisted.includes("envelope"));
  assert.ok(!persisted.includes("received_at"));
  assert.equal(readdirSync(f.stateDir).length, 1);
});

test("concurrent monitor writers and stale lock files fail closed", async context => {
  const f = fixture(context);
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  f.respond(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const first = f.run();
  await running;
  errorCode(await f.run(), "STATE_LOCKED");
  release(batch());
  await first;
  const lock = f.statePath().replace(/\.json$/u, ".lock");
  writeFileSync(lock, "", { mode: 0o600 });
  errorCode(await f.run(), "STATE_LOCKED");
  assert.ok(existsSync(lock));
});

test("symlink, unsafe mode, corrupt and scope-changed state are rejected", async context => {
  for (const mutation of ["link-file", "link-directory", "hardlink-file", "mode-file", "mode-directory", "corrupt", "unknown-field", "scope", "config"]) {
    const f = fixture(context);
    await f.run();
    const path = f.statePath(), original = readFileSync(path, "utf8");
    if (mutation === "link-file") { unlinkSync(path); symlinkSync(f.config, path); }
    if (mutation === "hardlink-file") linkSync(path, join(f.root, "extra-link"));
    if (mutation === "link-directory") {
      const alias = join(f.root, "alias"); symlinkSync(f.stateDir, alias); f.options.stateDir = alias;
    }
    if (mutation === "mode-file") chmodSync(path, 0o644);
    if (mutation === "mode-directory") chmodSync(f.stateDir, 0o755);
    if (mutation === "corrupt") writeFileSync(path, "{broken");
    if (mutation === "unknown-field") writeFileSync(path, JSON.stringify({ ...JSON.parse(original), subject: "should never be persisted" }));
    if (mutation === "scope") { const value = JSON.parse(original); value.scope.account = "beta"; writeFileSync(path, JSON.stringify(value)); }
    if (mutation === "config") writeFileSync(f.config, "[accounts.changed]\n");
    errorCode(await f.run(), ["scope", "config"].includes(mutation) ? "STATE_SCOPE_CHANGED" : "STATE_INVALID");
    assert.equal(f.calls.length, 1);
  }
});

test("configuration errors are typed and never invoke the child", async context => {
  const f = fixture(context);
  chmodSync(f.config, 0o644);
  await assert.rejects(f.run(), { code: "CONFIG" });
  chmodSync(f.config, 0o600);
  const link = join(f.root, "linked.toml"); symlinkSync(f.config, link);
  await assert.rejects(f.run(undefined, { config: link }), { code: "CONFIG" });
  assert.equal(f.calls.length, 0);
});

test("own deadline, output bytes, invalid JSON, exit and signal have safe distinct classifications", async () => {
  const execute = (script, limits) => executeRead(process.execPath, ["-e", script], limits);
  const cases = [
    ["process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { timeoutMs: 150, killGraceMs: 25 }, "TIMEOUT"],
    ["process.stdout.write('💌'.repeat(1000));setInterval(()=>{},1000)", { maxBytes: 1000, killGraceMs: 25 }, "OUTPUT_LIMIT"],
    ["process.stderr.write('SYNTHETIC_SECRET'.repeat(1000));setInterval(()=>{},1000)", { maxBytes: 1000, killGraceMs: 25 }, "OUTPUT_LIMIT"],
    ["console.log('SYNTHETIC_SECRET')", {}, "INVALID_JSON"],
    ["console.error('SYNTHETIC_SECRET');process.exit(7)", {}, "PROCESS_EXIT"],
    ["process.kill(process.pid,'SIGTERM')", {}, "PROCESS_EXIT"],
  ];
  for (const [script, limits, code] of cases) {
    const start = performance.now();
    await assert.rejects(execute(script, limits), error => {
      assert.equal(error.code, code);
      assert.ok(!JSON.stringify(error).includes("SYNTHETIC_SECRET"));
      assert.ok(!error.message.includes("SYNTHETIC_SECRET"));
      assert.ok(error.metrics.duration_ms >= 0);
      assert.ok(Number.isInteger(error.metrics.stdout_bytes));
      assert.ok(Number.isInteger(error.metrics.stderr_bytes));
      return true;
    });
    assert.ok(performance.now() - start < 3000);
  }
  await assert.rejects(executeRead("/nonexistent-synthetic-himalaya", []), { code: "PROCESS_EXIT" });
  assert.deepEqual(await execute("process.stdout.write(JSON.stringify({ok:'💌'}))"), { ok: "💌" });
  assert.throws(() => execute("console.log('{}')", { maxBytes: 1_048_577 }), { code: "ARGUMENT" });
  assert.throws(() => execute("console.log('{}')", { timeoutMs: 60_001 }), { code: "ARGUMENT" });
});

test("nonzero CLI typed errors are preserved without forwarding raw diagnostics", async context => {
  const f = fixture(context);
  const options = { ...f.options, execute: () => executeRead(process.execPath, ["-e", "console.log(JSON.stringify({version:1,account:'alpha',complete:false,error:{code:'UIDVALIDITY_CHANGED',message:'SYNTHETIC_SECRET'},entries:[]}));console.error('SYNTHETIC_SECRET');process.exit(1)"]) };
  const result = await runReadOnly(["inbox", "--account", "alpha", "--since", "30m"], options);
  errorCode(result, "UIDVALIDITY_CHANGED");
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
  assert.equal(result.accounts[0].error.exit_code, 1);
});

test("aggregate output retains earlier batches under a byte cap and never silently truncates", async context => {
  const f = fixture(context);
  const names = Array.from({ length: 20 }, (_, index) => `account-${index}`);
  f.respond(async command => command.includes("account") ? { accounts: names.map(name => ({ name })) } : batch(argument(command, "account"), { entries: [{ account: argument(command, "account"), mailbox: "INBOX", received_at: SINCE, envelope: { id: "1", subject: "界".repeat(40_000) } }], reason: "OUTPUT_BUDGET" }));
  const output = await f.run(["inbox", "--since", "30m"]);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) + 1 <= 1_048_576);
  assert.equal(output.accounts.length, 20);
  assert.ok(output.entries.length > 0 && output.entries.length < 20);
  assert.equal(output.complete, false);
  for (const account of output.accounts) {
    if (account.error) assert.equal(account.error.code, "OUTPUT_LIMIT");
    else assert.equal(account.next_cursor, "snapshot-next");
  }
  assert.equal(f.calls.length, output.entries.length + 1);
});

test("individual oversized responses and malformed scan contracts never become successful batches", async context => {
  const f = fixture(context);
  f.respond(async () => batch("alpha", { entries: [{ account: "alpha", mailbox: "INBOX", received_at: SINCE, envelope: { subject: "x".repeat(140_000) } }] }));
  errorCode(await f.run(), "OUTPUT_LIMIT");
  assert.equal(readdirSync(f.stateDir).length, 0);
  for (const change of [{ checkpoint: "premature" }, { next_cursor: null }, { account: "beta" }, { deferred: undefined }, { deferred: "false" }, { cursor: "x".repeat(16_385) }, { entries: [{ account: "alpha", mailbox: "INBOX", received_at: null, envelope: {} }] }]) {
    f.respond(async () => batch("alpha", change));
    errorCode(await f.run(), "INVALID_JSON");
  }
  assert.equal(readdirSync(f.stateDir).length, 0);
});

test("overall deadline stops new calls while keeping successful account coverage", async context => {
  const f = fixture(context);
  f.respond(async command => {
    if (command.includes("account")) return { accounts: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }] };
    if (argument(command, "account") === "alpha") return batch();
    await new Promise(resolve => setTimeout(resolve, 40));
    throw new ReadError("TIMEOUT");
  });
  const output = await f.run(["inbox", "--since", "30m"], { limits: { overallMs: 30 } });
  assert.equal(output.entries.length, 1);
  assert.equal(output.accounts[0].next_cursor, "snapshot-next");
  errorCode(output, "TIMEOUT", 1); errorCode(output, "TIMEOUT", 2);
  assert.equal(f.calls.length, 3);
});

test("pending batches survive output budget exhaustion without fetch or ack progress", async context => {
  const f = fixture(context);
  await f.run();
  const original = readFileSync(f.statePath(), "utf8");
  const result = await f.run(undefined, { limits: { outputBytes: 1000 } });
  errorCode(result, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) + 1 <= 1000);
  assert.equal(f.calls.length, 1);
  assert.equal(readFileSync(f.statePath(), "utf8"), original);
});

test("each monitor account has independent pending state and acknowledgement", async context => {
  const f = fixture(context);
  const initial = await f.run(["monitor"]);
  const alphaId = initial.accounts[0].batch_id, betaId = initial.accounts[1].batch_id;
  assert.notEqual(alphaId, betaId);
  assert.equal(readdirSync(f.stateDir).length, 2);
  await f.run(["monitor", "--account", "alpha", "--ack", alphaId]);
  const beta = await f.run(["monitor", "--account", "beta"]);
  assert.equal(beta.accounts[0].batch_id, betaId);
  assert.equal(argument(f.calls.at(-1).command, "cursor"), "snapshot-start");
  f.respond(async command => {
    assert.equal(argument(command, "cursor"), "snapshot-next");
    return batch("alpha", { cursor: "snapshot-next" });
  });
  assert.notEqual((await f.run()).accounts[0].batch_id, alphaId);
});

test("partial protocol failures keep their emitted prefix and continuation", async context => {
  const f = fixture(context);
  for (const reason of ["MISSING_FETCH_ROW", "MISSING_RECEIVED_AT", "SCAN_FAILED", "INVALID_UID_RESPONSE"]) {
    f.respond(async () => batch("alpha", { reason }));
    const result = await f.run(["inbox", "--account", "alpha", "--since", "30m"]);
    assert.equal(result.complete, false);
    assert.equal(result.entries.length, 1);
    assert.equal(result.accounts[0].reason, reason);
    assert.equal(result.accounts[0].next_cursor, "snapshot-next");
    assert.equal(result.accounts[0].checkpoint, null);
  }
});

test("a crash while fetching leaves a lock that is never automatically removed", async context => {
  const f = fixture(context);
  const moduleURL = new URL("./himalaya-readonly.mjs", import.meta.url).href;
  const script = `import { runReadOnly } from ${JSON.stringify(moduleURL)}; await runReadOnly(['monitor','--account','alpha'], {config:${JSON.stringify(f.config)},stateDir:${JSON.stringify(f.stateDir)},execute:async()=>process.exit(17)});`;
  await assert.rejects(executeRead(process.execPath, ["--input-type=module", "-e", script]), { code: "PROCESS_EXIT" });
  const files = readdirSync(f.stateDir);
  assert.equal(files.length, 1); assert.ok(files[0].endsWith(".lock"));
  errorCode(await f.run(), "STATE_LOCKED");
  assert.deepEqual(readdirSync(f.stateDir), files);
});

test("timed-out child and inherited-pipe helpers are killed within the cleanup bound", async () => {
  const script = "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore',process.stdout,process.stderr]});console.log('{}');process.exit(0)";
  const start = performance.now();
  await assert.rejects(executeRead(process.execPath, ["-e", script], { timeoutMs: 200, killGraceMs: 40 }), { code: "TIMEOUT" });
  assert.ok(performance.now() - start < 2000);
});

test("limit escalation kills ignored-stdio descendants even when their parent exits on TERM", async context => {
  if (process.platform === "win32") return context.skip("POSIX process-group fixture");
  const f = fixture(context);
  for (const code of ["TIMEOUT", "OUTPUT_LIMIT"]) {
    const pidFile = join(f.root, `${code}.pid`);
    const helper = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
    const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>process.exit(0));const helper=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','ignore','ignore','ipc']});helper.on('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(helper.pid));process.stdout.write(${JSON.stringify(code === "OUTPUT_LIMIT" ? "x".repeat(2000) : "{}")});});setInterval(()=>{},1000)`;
    let cleanupError;
    try {
      await assert.rejects(executeRead(process.execPath, ["-e", script], { timeoutMs: 3000, maxBytes: 1000, killGraceMs: 80 }), { code });
      assert.ok(existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, "utf8"));
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
        catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
      }
      assert.equal(alive, false);
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") cleanupError = error; }
      }
    }
    if (cleanupError) throw cleanupError;
  }
});

test("deferred snapshots expose the flag and bind it to the pending fingerprint", async context => {
  const f = fixture(context);
  f.respond(async () => batch("alpha", { complete: true, deferred: true, next_cursor: null, checkpoint: "deferred-floor", reason: null }));
  const initial = await f.run();
  assert.equal(initial.complete, true);
  assert.equal(initial.accounts[0].deferred, true);
  const original = readFileSync(f.statePath(), "utf8");
  f.respond(async () => batch("alpha", { complete: true, deferred: false, next_cursor: null, checkpoint: "deferred-floor", reason: null }));
  errorCode(await f.run(), "REPLAY_CHANGED");
  assert.equal(readFileSync(f.statePath(), "utf8"), original);
  await f.run(["monitor", "--account", "alpha", "--ack", initial.accounts[0].batch_id]);
  f.respond(async command => {
    assert.equal(argument(command, "after"), "deferred-floor");
    assert.equal(argument(command, "as-of"), undefined);
    return batch("alpha", { cursor: "deferred-next-round" });
  });
  const later = await f.run();
  assert.equal(later.entries[0].envelope.id, initial.entries[0].envelope.id);
  assert.notEqual(later.accounts[0].batch_id, initial.accounts[0].batch_id);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, realpath, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeAntigravityTransport, antigravityCliModels } from "./native-antigravity-transport.mjs";

const fake = fileURLToPath(new URL("./testing/fake-native-antigravity.mjs", import.meta.url));
const model = "claude-sonnet-5-5-medium";
async function fixture(t, overrides = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omb-native-agy-test-")));
  const native = join(dir, "native"); await mkdir(native);
  const options = { command: process.execPath, args: [fake], directory: join(dir, "bridge"),
    env: { ...process.env, FAKE_AGY_DIRECTORY: native }, ...overrides };
  const transport = new NativeAntigravityTransport(options);
  const state = await transport.create({ cwd: dir, model });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, native, options, transport, state };
}

test("discovers only the native table and keeps Sonnet's exact ID", async t => {
  const { transport } = await fixture(t);
  assert.deepEqual((await transport.models()).map(value => value.id), [model, "gemini-3.8-flash-high"]);
  assert.throws(() => antigravityCliModels("not a model list"));
});

test("forwards the exact original input on stdin, not argv or a mediator envelope", async t => {
  const { transport, state, native } = await fixture(t);
  const text = "相談です。\n' ` $HOME $(do-not-run) 👋";
  const result = await transport.prompt(state.id, text);
  const receipt = JSON.parse((await readFile(join(native, "receipts.jsonl"), "utf8")).trim());
  assert.equal(receipt.text, text);
  assert.ok(!receipt.args.includes(text));
  assert.ok(!receipt.args.includes("--dangerously-skip-permissions"));
  assert.match(result.text, /相談です/u);
  assert.equal((await stat(transport.path(state.id))).mode & 0o777, 0o600);
});

test("resumes the same native history after adapter restart and model changes", async t => {
  const { transport, state, options, native } = await fixture(t);
  const first = await transport.prompt(state.id, "first");
  const restarted = new NativeAntigravityTransport(options);
  await restarted.select(state.id, "gemini-3.8-flash-high");
  const second = await restarted.prompt(state.id, "second");
  assert.equal(first.nativeId, second.nativeId);
  assert.match(second.text, /:2:second$/u);
  assert.deepEqual(JSON.parse(await readFile(join(native, `${first.nativeId}.json`), "utf8")), ["first", "second"]);
});

test("separates native sessions for separate OMB conversation IDs", async t => {
  const { transport, state, dir } = await fixture(t);
  const other = await transport.create({ cwd: dir, model });
  const results = await Promise.all([transport.prompt(state.id, "one"), transport.prompt(other.id, "two")]);
  assert.notEqual(results[0].nativeId, results[1].nativeId);
});

test("shows native tool activity and excludes hidden thinking", async t => {
  const { transport, state } = await fixture(t);
  const progress = [];
  await transport.prompt(state.id, "hello", { progress: value => progress.push(value) });
  assert.deepEqual(progress.map(value => value.state), ["in_progress", "completed"]);
  assert.ok(!JSON.stringify(progress).includes("PRIVATE_THINKING"));
});

test("reports permission notices without leaking raw stderr", async t => {
  const { transport, state } = await fixture(t);
  assert.equal((await transport.prompt(state.id, "PERMISSION")).permissionNotice, true);
  assert.ok(!JSON.stringify(await transport.prompt(state.id, "SECRET_STDERR")).includes("provider-secret"));
});

for (const message of ["DISCONNECT", "MISMATCH", "MALFORMED", "NONZERO"]) {
  test(`${message} never reports success or automatically replays an uncertain request`, async t => {
    const { transport, state, options, native } = await fixture(t);
    await assert.rejects(transport.prompt(state.id, message));
    assert.equal((await transport.read(state.id)).pending, true);
    await assert.rejects(new NativeAntigravityTransport(options).prompt(state.id, "retry"), /未確認/u);
    assert.equal((await readFile(join(native, "receipts.jsonl"), "utf8")).trim().split("\n").length, 1);
  });
}

test("does not turn WAITING into a successful completion", async t => {
  const { transport, state } = await fixture(t);
  await assert.rejects(transport.prompt(state.id, "WAITING"), /WAITING/u);
  assert.equal((await transport.read(state.id)).lastStatus, "WAITING");
});

test("cancellation stops an owned process and releases its OMB input lock", async t => {
  const { transport, state, dir } = await fixture(t);
  const controller = new AbortController();
  const pending = assert.rejects(transport.prompt(state.id, "HANG", { signal: controller.signal }), /停止/u);
  const timer = setTimeout(() => controller.abort(), 150);
  await pending; clearTimeout(timer);
  assert.equal(transport.active.size, 0);
  assert.ok(!(await readdir(join(dir, "bridge"))).some(file => file.endsWith(".lock")));
});

test("refuses simultaneous input across separate adapter objects", async t => {
  const { transport, state, options } = await fixture(t);
  const controller = new AbortController();
  const pending = assert.rejects(transport.prompt(state.id, "HANG", { signal: controller.signal }));
  while (!transport.active.size) await new Promise(resolve => setTimeout(resolve, 10));
  try { await assert.rejects(new NativeAntigravityTransport(options).prompt(state.id, "second"), /処理中/u); }
  finally { controller.abort(); await pending; }
});

test("times out without a successful completion or retry", async t => {
  const { transport, state } = await fixture(t, { timeoutMs: 150 });
  await assert.rejects(transport.prompt(state.id, "HANG"), /タイムアウト/u);
  assert.equal((await transport.read(state.id)).pending, true);
});

test("rejects traversal, shared state directories, and symlinks", async t => {
  const { transport, state, dir, options } = await fixture(t);
  await assert.rejects(transport.prompt("../escape", "hello"), /無効/u);
  const link = join(dir, "linked"); await symlink(options.directory, link);
  await assert.rejects(new NativeAntigravityTransport({ ...options, directory: link }).read(state.id), /実ディレクトリ/u);
});


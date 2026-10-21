import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_BINARY = join(homedir(), ".local/libexec/himalaya-openmausbot/himalaya");
const DEFAULT_CONFIG = join(homedir(), ".config/himalaya-security-test/config.toml");
const MIB = 1_048_576;
const SCAN_BYTES = 131_072;
const TOKEN_BYTES = 16_384;
const MAX_ACCOUNTS = 64;
const FORK_ERRORS = new Set(["INVALID_CURSOR", "CURSOR_SCOPE_CHANGED", "UIDVALIDITY_CHANGED", "UNSUPPORTED_BACKEND", "SCAN_FAILED", "ACCOUNT_REQUIRED", "CONFIG_ERROR", "MISSING_UID_METADATA", "UID_STATE_REGRESSED", "INVALID_UID_RESPONSE", "INVALID_WINDOW"]);
const SCAN_REASONS = new Set(["PAGE_LIMIT", "ENTRY_TOO_LARGE", "OUTPUT_BUDGET", "MISSING_FETCH_ROW", "MISSING_RECEIVED_AT", "SCAN_FAILED", "INVALID_UID_RESPONSE"]);
const SAFE_ERRORS = new Set([...FORK_ERRORS, "TIMEOUT", "OUTPUT_LIMIT", "PROCESS_EXIT", "INVALID_JSON", "ARGUMENT", "CONFIG", "STATE_INVALID", "STATE_SCOPE_CHANGED", "STATE_LOCKED", "ACK_MISMATCH", "REPLAY_CHANGED"]);
const SCAN_OPTIONS = ["account", "mailbox", "since", "all-time", "page-size", "max-pages", "max-bytes"];
const OPTIONS = {
  accounts: [],
  inbox: [...SCAN_OPTIONS, "cursor", "after", "as-of"],
  monitor: [...SCAN_OPTIONS, "ack"],
  mailboxes: ["account"],
  list: ["account", "mailbox", "page", "page-size"],
  read: ["account", "mailbox", "id"],
  search: ["account", "mailbox", "query", "page", "page-size"],
};

export class ReadError extends Error {
  constructor(code, metrics = {}) {
    super(SAFE_ERRORS.has(code) ? code : "PROCESS_EXIT");
    this.code = this.message;
    this.metrics = {};
    for (const key of ["duration_ms", "stdout_bytes", "stderr_bytes", "exit_code"]) {
      if (metrics[key] === null || Number.isSafeInteger(metrics[key])) this.metrics[key] = metrics[key];
    }
    if (metrics.signal === null || /^SIG[A-Z0-9]{1,12}$/u.test(metrics.signal ?? "")) this.metrics.signal = metrics.signal;
    if (FORK_ERRORS.has(metrics.cli_code)) this.metrics.cli_code = metrics.cli_code;
  }
}

function fail(code) { throw new ReadError(code); }
function safeError(error) {
  return error instanceof ReadError ? { code: error.code, ...error.metrics } : { code: "PROCESS_EXIT" };
}
function text(value, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) fail("ARGUMENT");
  return value;
}
function token(value) { return text(value, TOKEN_BYTES); }
function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value) || Number(value) > maximum) fail("ARGUMENT");
  return Number(value);
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) fail("ARGUMENT");
  return value;
}
function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.length > 32 || argv.some(arg => typeof arg !== "string") || Buffer.byteLength(argv.join("\0")) > 32_768) fail("ARGUMENT");
  const [operation, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, operation ?? "")) fail("ARGUMENT");
  let values;
  try {
    const parsed = parseArgs({ args: rest, strict: true, allowPositionals: false, tokens: true,
      options: Object.fromEntries(OPTIONS[operation].map(name => [name, { type: name === "all-time" ? "boolean" : "string" }])) });
    if (new Set(parsed.tokens.map(item => item.name)).size !== parsed.tokens.length) fail("ARGUMENT");
    values = parsed.values;
  } catch { fail("ARGUMENT"); }
  for (const key of ["account", "mailbox"]) if (values[key] !== undefined) text(values[key]);
  if (!["accounts", "inbox", "monitor"].includes(operation) && values.account === undefined) fail("ARGUMENT");
  if (values.since !== undefined && (!/^[1-9][0-9]{0,7}[smhd]$/u.test(values.since) || values["all-time"])) fail("ARGUMENT");
  for (const key of ["cursor", "after"]) if (values[key] !== undefined) token(values[key]);
  if ((values.cursor || values.after) && !values.account || values.cursor && values.after) fail("ARGUMENT");
  if (values["as-of"] !== undefined) timestamp(values["as-of"]);
  if (values.ack !== undefined && (!values.account || !validBatchId(values.ack))) fail("ARGUMENT");
  if (operation === "monitor" && !values.since && !values["all-time"]) values.since = "30m";
  integer(values.page, 1, 100);
  integer(values["page-size"], 25, 100);
  if (["inbox", "monitor"].includes(operation)) {
    integer(values["max-pages"], 4, 100);
    if (integer(values["max-bytes"], SCAN_BYTES, SCAN_BYTES) < 8192) fail("ARGUMENT");
  }
  if (operation === "read") text(values.id);
  if (operation === "search") text(values.query, 2000);
  return { operation, values };
}
function baseCommand(config, account) {
  return ["-c", config, "--json", "--log-level", "off", ...(account === undefined ? [] : [`--account=${account}`])];
}
function buildCommand(operation, values, config, scan = false) {
  const command = baseCommand(config, values.account);
  const mailbox = values.mailbox === undefined ? [] : [`--mailbox=${values.mailbox}`];
  const page = ["--page", String(integer(values.page, 1, 100)), "--page-size", String(integer(values["page-size"], 25, 100))];
  switch (operation) {
    case "accounts": return [...command, "account", "list"];
    case "mailboxes": return [...command, "mailbox", "list"];
    case "list": return [...command, "envelope", "list", ...mailbox, ...page];
    case "read": return [...command, "message", "read", ...mailbox, "--", text(values.id)];
    case "search": return [...command, "envelope", "search", ...mailbox, ...page, "--", text(values.query, 2000)];
    default: {
      const result = [...command, "inbox", scan ? "scan" : "list", ...mailbox];
      if (values.since) result.push("--since", values.since);
      if (values["all-time"]) result.push("--all-time");
      result.push("--page-size", String(Math.min(50, integer(values["page-size"], 25, 100))), "--max-pages", String(Math.min(4, integer(values["max-pages"], 4, 100))));
      if (scan) {
        result.push("--max-bytes", String(integer(values["max-bytes"], SCAN_BYTES, SCAN_BYTES)));
        for (const key of ["cursor", "after", "as-of"]) if (values[key] !== undefined) result.push(`--${key}=${values[key]}`);
      }
      return result;
    }
  }
}
export function readCommand(argv, config = DEFAULT_CONFIG) {
  const { operation, values } = argumentsFor(argv);
  if (operation === "monitor") fail("ARGUMENT");
  return buildCommand(operation, values, config, Boolean(values.since || values.cursor || values.after || values["as-of"]));
}

function limit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("ARGUMENT");
  return value;
}
export function executeRead(binary, command, limits = {}) {
  const timeoutMs = limit(limits.timeoutMs, 12_000, 60_000);
  const maxBytes = limit(limits.maxBytes, MIB, MIB);
  const killGraceMs = limit(limits.killGraceMs, 250, 500);
  return new Promise((accept, reject) => {
    const started = performance.now();
    let stdoutBytes = 0, stderrBytes = 0, marker, done = false, closed = false, exitCode = null, exitSignal = null;
    const chunks = [];
    let timer, killTimer, reapTimer, child;
    const finish = () => {
      // A closed direct child does not prove its POSIX process group has exited.
      if (done || marker && killTimer) return;
      done = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer);
      const metrics = { duration_ms: Math.round(performance.now() - started), stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, exit_code: exitCode, signal: exitSignal };
      let parsed;
      if (!marker) {
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { marker = exitCode === 0 ? "INVALID_JSON" : "PROCESS_EXIT"; }
        if (exitCode !== 0) {
          marker = "PROCESS_EXIT";
          if (FORK_ERRORS.has(parsed?.error?.code)) metrics.cli_code = parsed.error.code;
        }
      }
      if (marker) reject(new ReadError(marker, metrics));
      else accept(parsed);
    };
    const signalChild = signal => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* An exited process group needs no further signal. */ }
    };
    const stop = code => {
      if (marker || done) return;
      marker = code;
      signalChild("SIGTERM");
      killTimer = setTimeout(() => {
        signalChild("SIGKILL");
        killTimer = undefined;
        if (closed) finish();
      }, killGraceMs);
      // Descendants can retain inherited pipes after the direct child has exited.
      reapTimer = setTimeout(() => {
        signalChild("SIGKILL");
        child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish();
      }, killGraceMs * 2);
    };
    try {
      child = spawn(binary, command, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUST_LOG: "off", NO_COLOR: "1" } });
    } catch { marker = "PROCESS_EXIT"; finish(); return; }
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxBytes) stop("OUTPUT_LIMIT");
      if (!marker) chunks.push(chunk);
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxBytes) stop("OUTPUT_LIMIT");
    });
    child.on("error", () => { marker ??= "PROCESS_EXIT"; finish(); });
    child.on("exit", (code, signal) => { exitCode = code; exitSignal = signal; });
    child.on("close", () => { closed = true; finish(); });
    timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
  });
}

function privateStat(stat, directory, code) {
  if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail(code);
  return stat;
}
function configIdentity(config) {
  try {
    const stat = privateStat(lstatSync(config), false, "CONFIG");
    return createHash("sha256").update(JSON.stringify([resolve(config), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest("hex");
  } catch { fail("CONFIG"); }
}
function checkDirectories(directory, privateLeaf = true) {
  const absolute = resolve(directory);
  let path = parse(absolute).root;
  for (const part of absolute.slice(path.length).split("/").filter(Boolean)) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022) && !(stat.uid === 0 && stat.mode & 0o1000)) fail("STATE_INVALID");
  }
  return privateLeaf ? privateStat(lstatSync(absolute), true, "STATE_INVALID") : lstatSync(absolute);
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function validResume(value) {
  return value === null || exactKeys(value, ["kind", "token"]) && ["cursor", "after"].includes(value.kind) && token(value.token);
}
function validRequest(value) {
  return exactKeys(value, ["page_size", "max_pages", "max_bytes", "as_of"]) &&
    integer(String(value.page_size), 25, 50) && integer(String(value.max_pages), 4, 4) && integer(String(value.max_bytes), SCAN_BYTES, SCAN_BYTES) >= 8192 && timestamp(value.as_of);
}
function validBatchId(value) { return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value); }

function stateStore(directory, scope, identity) {
  let lockFd;
  const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const path = join(directory, `${key}.json`), lockPath = join(directory, `${key}.lock`);
  let directoryStat;
  const check = () => { if (!sameFile(directoryStat, checkDirectories(directory))) fail("STATE_INVALID"); };
  const read = () => {
    let fd;
    let opening = false;
    try {
      check();
      opening = true;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      opening = false;
      const stat = privateStat(fstatSync(fd), false, "STATE_INVALID");
      if (stat.size > SCAN_BYTES) fail("STATE_INVALID");
      const state = JSON.parse(readFileSync(fd, "utf8"));
      if (!exactKeys(state, ["version", "scope", "identity", "resume", "pending", "last_ack"]) || state.version !== 1) fail("STATE_INVALID");
      if (JSON.stringify(state.scope) !== JSON.stringify(scope) || state.identity !== identity) fail("STATE_SCOPE_CHANGED");
      if (!validResume(state.resume) || state.last_ack !== null && !validBatchId(state.last_ack)) fail("STATE_INVALID");
      if (state.pending !== null) {
        const pending = state.pending;
        if (!exactKeys(pending, ["batch_id", "cursor", "advance", "request", "fingerprint"]) || !validBatchId(pending.batch_id) || !token(pending.cursor) || !validResume(pending.advance) || !pending.advance || !validRequest(pending.request) || !/^[a-f0-9]{64}$/u.test(pending.fingerprint)) fail("STATE_INVALID");
      }
      return state;
    } catch (error) {
      if (error.code === "ENOENT" && opening) return { version: 1, scope, identity, resume: null, pending: null, last_ack: null };
      if (error instanceof ReadError && error.code === "STATE_SCOPE_CHANGED") throw error;
      fail("STATE_INVALID");
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  const write = state => {
    let fd, temporary;
    try {
      check();
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > SCAN_BYTES) fail("STATE_INVALID");
      try { privateStat(lstatSync(path), false, "STATE_INVALID"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      temporary = join(directory, `${key}.${randomUUID()}.tmp`);
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, serialized); fsyncSync(fd); closeSync(fd); fd = undefined;
      check(); renameSync(temporary, path); temporary = undefined;
      const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { fail("STATE_INVALID"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* A failed private temporary file is never used as state. */ } }
    }
  };
  try {
    checkDirectories(dirname(directory), false);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    directoryStat = checkDirectories(directory);
    lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    privateStat(fstatSync(lockFd), false, "STATE_INVALID"); fsyncSync(lockFd);
  } catch (error) {
    if (lockFd !== undefined) closeSync(lockFd);
    fail(error.code === "EEXIST" ? "STATE_LOCKED" : "STATE_INVALID");
  }
  return { read, write, close() {
    try { check(); if (!sameFile(fstatSync(lockFd), lstatSync(lockPath))) fail("STATE_INVALID"); unlinkSync(lockPath); }
    catch { fail("STATE_INVALID"); }
    finally { closeSync(lockFd); }
  } };
}

function scanResult(data, account) {
  try {
    if (data?.version !== 1 || data.account !== account || !Array.isArray(data.entries) || typeof data.complete !== "boolean") fail("INVALID_JSON");
    if (data.error) {
      if (!FORK_ERRORS.has(data.error.code) || data.complete || data.entries.length) fail("INVALID_JSON");
      throw new ReadError(data.error.code);
    }
    if (typeof data.deferred !== "boolean") fail("INVALID_JSON");
    text(data.mailbox); timestamp(data.as_of);
    if (data.since !== null) timestamp(data.since);
    for (const key of ["scanned", "matched", "uid_validity", "snapshot_uid"]) if (!Number.isSafeInteger(data[key]) || data[key] < 0) fail("INVALID_JSON");
    token(data.cursor);
    if (data.complete ? data.next_cursor !== null || !token(data.checkpoint) : data.checkpoint !== null || !token(data.next_cursor)) fail("INVALID_JSON");
    if (data.reason !== null && !SCAN_REASONS.has(data.reason)) fail("INVALID_JSON");
    if (data.uid_validity === 0 || data.matched !== data.entries.length || data.scanned < data.matched || data.complete && data.reason !== null) fail("INVALID_JSON");
    if (data.entries.some(entry => entry.account !== account || entry.mailbox !== data.mailbox || !entry.envelope || !timestamp(entry.received_at))) fail("INVALID_JSON");
    return Object.fromEntries(["version", "account", "mailbox", "since", "as_of", "complete", "deferred", "scanned", "matched", "uid_validity", "snapshot_uid", "cursor", "next_cursor", "checkpoint", "reason", "entries"].map(key => [key, data[key]]));
  } catch (error) {
    if (error instanceof ReadError && FORK_ERRORS.has(error.code)) throw error;
    fail("INVALID_JSON");
  }
}
function legacyResult(data, account) {
  if (!data || typeof data.complete !== "boolean" || !Array.isArray(data.entries) || !Array.isArray(data.accounts) || data.accounts.length !== 1 || data.accounts[0].account !== account) fail("INVALID_JSON");
  const coverage = data.accounts[0];
  if (coverage.error) throw new ReadError("SCAN_FAILED");
  if (data.entries.some(entry => entry.account !== account)) fail("INVALID_JSON");
  return { account, since: data.since, as_of: data.as_of, complete: data.complete && coverage.exhausted === true && coverage.missing_received_at === 0 && coverage.repeated_ids === 0,
    scanned: coverage.scanned, exhausted: coverage.exhausted, missing_received_at: coverage.missing_received_at, repeated_ids: coverage.repeated_ids,
    cursor: null, next_cursor: null, checkpoint: null, entries: data.entries };
}
function bytes(value) { return Buffer.byteLength(JSON.stringify(value)) + 1; }

export async function runReadOnly(argv, { binary = DEFAULT_BINARY, config = DEFAULT_CONFIG, execute = executeRead, stateDir = join(dirname(config), "monitor-state"), limits = {} } = {}) {
  const { operation, values } = argumentsFor(argv);
  const identity = configIdentity(config);
  const outputBytes = limit(limits.outputBytes, MIB, MIB);
  const childBytes = limit(limits.maxBytes, MIB, MIB);
  const deadline = performance.now() + limit(limits.overallMs, 52_000, 53_000);
  const childMs = limit(limits.timeoutMs, 12_000, 12_000);
  const call = async (command, maxBytes = childBytes) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) fail("TIMEOUT");
    const data = await execute(binary, command, { timeoutMs: Math.min(childMs, remaining), maxBytes: Math.min(childBytes, maxBytes), killGraceMs: limits.killGraceMs });
    if (bytes(data) > Math.min(childBytes, maxBytes)) fail("OUTPUT_LIMIT");
    return data;
  };
  if (!["inbox", "monitor"].includes(operation)) {
    const data = await call(buildCommand(operation, values, config));
    if (data?.error) fail(FORK_ERRORS.has(data.error.code) ? data.error.code : "PROCESS_EXIT");
    if (bytes(data) > outputBytes) fail("OUTPUT_LIMIT");
    return data;
  }
  const monitor = operation === "monitor";
  let accounts;
  if (values.account) accounts = [values.account];
  else {
    const data = await call(buildCommand("accounts", {}, config));
    if (!Array.isArray(data?.accounts)) fail("INVALID_JSON");
    if (!data.accounts.length || data.accounts.length > MAX_ACCOUNTS) fail("CONFIG");
    try { accounts = data.accounts.map(account => text(account.name)); } catch { fail("INVALID_JSON"); }
    if (new Set(accounts).size !== accounts.length) fail("INVALID_JSON");
  }
  const output = { version: 1, complete: true, accounts: [], entries: [] };
  const reserved = accounts.reduce((sum, account) => sum + Buffer.byteLength(JSON.stringify(account)) + 256, 0);
  if (bytes(output) + reserved >= outputBytes) fail("OUTPUT_LIMIT");
  let reserve = reserved;
  for (const account of accounts) {
    reserve -= Buffer.byteLength(JSON.stringify(account)) + 256;
    let store;
    try {
      const available = outputBytes - bytes(output) - reserve - 512;
      let request = { ...values, account };
      let state;
      if (monitor) {
        const scope = { config: resolve(config), account, mailbox: values.mailbox ?? null, window: values.since ?? "all-time" };
        store = stateStore(resolve(stateDir), scope, identity);
        state = store.read();
        if (values.ack) {
          if (state.last_ack !== values.ack) {
            if (state.pending?.batch_id !== values.ack) fail("ACK_MISMATCH");
            state.resume = state.pending.advance; state.pending = null; state.last_ack = values.ack; store.write(state);
          }
          output.accounts.push({ account, acknowledged: values.ack });
          continue;
        }
        if (state.pending) {
          const pending = state.pending;
          request = { ...request, cursor: pending.cursor, "page-size": String(pending.request.page_size), "max-pages": String(pending.request.max_pages), "max-bytes": String(pending.request.max_bytes), "as-of": pending.request.as_of };
        } else if (state.resume) request[state.resume.kind] = state.resume.token;
      }
      const scan = monitor || Boolean(request.since || request.cursor || request.after || request["as-of"]);
      const maximum = Math.min(SCAN_BYTES, integer(request["max-bytes"], SCAN_BYTES, SCAN_BYTES));
      // Keep complete CLI batches intact so no continuation can skip an omitted entry.
      if (available < maximum) fail("OUTPUT_LIMIT");
      let result;
      try {
        const data = await call(buildCommand(operation, request, config, scan), scan ? maximum : Math.min(childBytes, available));
        result = scan ? scanResult(data, account) : legacyResult(data, account);
      } catch (error) {
        if (error instanceof ReadError && error.metrics.cli_code) throw new ReadError(error.metrics.cli_code, error.metrics);
        throw error;
      }
      if (monitor) {
        const advance = result.complete ? { kind: "after", token: result.checkpoint } : { kind: "cursor", token: result.next_cursor };
        const fingerprint = createHash("sha256").update(JSON.stringify(result)).digest("hex");
        if (state.pending && (result.cursor !== state.pending.cursor || JSON.stringify(advance) !== JSON.stringify(state.pending.advance) || fingerprint !== state.pending.fingerprint)) fail("REPLAY_CHANGED");
        state.pending ??= { batch_id: randomUUID(), cursor: result.cursor, advance, fingerprint, request: {
          page_size: Math.min(50, integer(request["page-size"], 25, 100)), max_pages: Math.min(4, integer(request["max-pages"], 4, 100)), max_bytes: maximum, as_of: result.as_of,
        } };
        result.batch_id = state.pending.batch_id;
      }
      const { entries, ...coverage } = result;
      const candidate = { ...output, complete: output.complete && result.complete, accounts: [...output.accounts, coverage], entries: [...output.entries, ...entries] };
      if (bytes(candidate) + reserve > outputBytes) fail("OUTPUT_LIMIT");
      if (monitor) store.write(state);
      Object.assign(output, candidate);
    } catch (error) {
      output.complete = false;
      output.accounts.push({ account, complete: false, error: safeError(error), next_cursor: null, checkpoint: null });
    } finally {
      if (store) {
        try { store.close(); }
        catch (error) {
          output.complete = false;
          const coverage = output.accounts.find(item => item.account === account);
          if (coverage) { coverage.complete = false; coverage.error = safeError(error); }
        }
      }
    }
  }
  if (bytes(output) > outputBytes) fail("OUTPUT_LIMIT");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runReadOnly(process.argv.slice(2))) + "\n"); }
  catch (error) {
    process.stdout.write(JSON.stringify({ version: 1, complete: false, error: safeError(error), entries: [] }) + "\n");
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function fixture(t, saved, { advertise = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-phone-https-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "companion-hosted-url.json"), JSON.stringify({ hostedUrl: saved }));
  let advertised = null;
  let state = { enabled: false, devices: [], pairing: null };
  let connectorOptions;
  let resolveConnector;
  let connectorStatus = { status: "connecting", configured: true, ready: false };
  const managedOperation = new Promise(resolve => { resolveConnector = resolve; });
  const handlers = new Map();
  const context = vm.createContext({
    URL, fs, path, process, AbortSignal,
    app: { isPackaged: false, getPath: () => directory },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    localOnly: (_name, handler) => handler,
    companionDesiredThisLaunch: false,
    companionLaunchGeneration: 0,
    advertisementTransition: Promise.resolve(),
    managedCompanionConnector: null,
    secureCredentials: {},
    companionAccountCleanupPending: () => false,
    managedCompanionTunnelAccess: () => ({ endpoint: "https://managed.example.test" }),
    companionRouteOn: () => true,
    companionOriginTarget: () => "http://127.0.0.1:8810",
    runtimeResourcesPath: directory,
    SERVER_PORT: 4000,
    companionMutationToken: "fixture",
    phoneSecretIdentity: null,
    serverProc: null,
    syncCompanionKeepAwake: () => {},
    tailnetShare: { state: () => ({ on: false }) },
    slog: () => {},
    managedRemoteAccessRefusal: () => null,
    startCompanion: async options => {
      advertised = advertise ? options.hostedUrl : null;
      state = { ...state, enabled: true, endpoints: advertised ? [{ url: advertised, kind: "hosted", priority: 0 }] : [] };
      return state;
    },
    companionState: async () => ({ ...state, endpoints: advertised ? [{ url: advertised, kind: "hosted", priority: 0 }] : [] }),
    companionRunning: () => state.enabled,
    companionAdvertisedHostedUrl: () => advertised,
    setCompanionHostedUrl: async value => {
      if (advertise) advertised = value;
      return state;
    },
    rememberCompanionRoute: async () => {},
    phoneLinkRoutes: { touched: () => {} },
    resolveCloudflaredBinary: () => "fixture",
    resolveManagedCompanionGuardian: () => "fixture",
    runtimeAppPath: directory,
    createManagedCompanionTunnel: options => {
      connectorOptions = options;
      return { getStatus: () => connectorStatus, start: () => managedOperation, stop: async () => {} };
    },
  });
  vm.runInContext(slice("const hostedOriginFile =", "function publicDesktopRemoteState()"), context);
  vm.runInContext(slice("function publicManagedCompanionState()", "const tailnetShare ="), context);
  vm.runInContext(slice("async function stopManagedCompanionEndpointLocally()", "async function activatePersistedManagedCompanionEndpoint()"), context);
  return {
    context, handlers, directory,
    advertised: () => advertised,
    saved: () => context.readSavedHostedUrl(),
    start: () => context.startDesktopCompanion(),
    async ready() {
      connectorStatus = { status: "ready", configured: true, ready: true, endpoint: "https://managed.example.test" };
      resolveConnector(connectorStatus);
      connectorOptions.onChange(connectorStatus);
      await context.advertisementTransition;
    },
  };
}

test("saved custom HTTPS starts without waiting for the managed connector and stays preferred when it connects", async t => {
  const f = fixture(t, " https://PHONE.example.test:8443/ ");
  assert.equal(f.saved(), "https://phone.example.test:8443");
  const started = await f.start();
  assert.equal(started.customHostedUrl, "https://phone.example.test:8443");
  assert.equal(f.advertised(), "https://phone.example.test:8443");
  assert.equal(started.managedConnection.ready, false);
  await f.ready();
  assert.equal(f.advertised(), "https://phone.example.test:8443");
  await f.context.stopManagedCompanionEndpointLocally();
  assert.equal(f.advertised(), "https://phone.example.test:8443");
  await f.handlers.get("companion:hosted-url")(null, null);
  assert.equal(f.saved(), null);
  assert.equal(f.advertised(), "https://managed.example.test");
});

test("opening the HTTPS settings only reads the address; explicit clear preserves the computer entrance", async t => {
  const f = fixture(t, "https://phone.example.test");
  const file = path.join(f.directory, "companion-hosted-url.json");
  const document = JSON.stringify({ version: 1, hostedUrl: "https://phone.example.test", harnessUrl: "https://computer.example.test" });
  fs.writeFileSync(file, document);
  const handler = f.handlers.get("companion:hosted-url");
  assert.equal((await handler(null)).hostedUrl, "https://phone.example.test");
  assert.equal((await handler(null)).hostedUrl, "https://phone.example.test");
  assert.equal(fs.readFileSync(file, "utf8"), document);
  await handler(null, null);
  assert.equal(f.saved(), null);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).harnessUrl, "https://computer.example.test");
});

for (const invalid of [null, "http://phone.example.test", "https://user:pass@phone.example.test", "https://phone.example.test/path", "https://phone.example.test/?q=x", "https://phone..example.test", "broken"]) {
  test(`invalid saved entrance does not bypass managed verification: ${invalid}`, async t => {
    const f = fixture(t, invalid);
    assert.equal(f.saved(), null);
    let finished = false;
    const start = f.start().then(answer => { finished = true; return answer; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    await f.ready();
    await start;
    assert.equal(f.advertised(), "https://managed.example.test");
  });
}

test("valid saved entrance that the sidecar did not advertise still waits for managed verification", async t => {
  const f = fixture(t, "https://phone.example.test", { advertise: false });
  let finished = false;
  const start = f.start().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  await f.ready();
  await start;
});

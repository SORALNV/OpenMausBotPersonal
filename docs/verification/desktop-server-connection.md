# Desktop server connection

Run the real Settings connection component in disposable Electron windows:

```sh
node scripts/verify-server-connection.mjs
```

Use the repository's installed dependencies, including the Electron binary.
Linux needs a graphical session (or run the command through `xvfb-run -a`).
The script creates its own loopback Vite preview, temporary HOME and Electron
profile. It accepts no server URL and blocks requests outside that preview
and the isolated fake-engine server it starts.
It never opens the operator's app, server list, credentials or browser profile.

The smoke mounts `RemoteComputerSection`, `ConnectedWorkspacesSettings`, and
`DesktopWorkspaceSwitcher` with the real styles and `electron/preload.cjs`.
It also opens the real app shell against a disposable fake-engine server.
It checks:

- A full custom HTTPS pairing link, including its 12-character code, reaches
  `environments:add-from-link` unchanged and never calls companion pairing.
- Duplicate submissions are blocked while a response is pending.
- Cancellation, rejection and retry restore a usable form; Electron's error
  wrapper is removed from the visible message.
- Desktop companion mode still sends a normalized six-digit code through
  `desktop-remote:pair`.
- The 390px layout has no horizontal document overflow.
- The server list opens the current connection modal, which accepts an address
  or full pairing link and displays the name from the server descriptor.
  Cancellation retains input; confirmed connections preserve the existing list
  and exclude the pairing code from saved connection data. Two submits before
  React renders the pending state still send only one connection request.
- The production native menu's Connect item requests Settings; its saved
  workspace items dispatch fixed IDs. Settings can switch connections and
  cancel or confirm forgetting just one saved connection.
- The local app opens Servers as a top-level Settings page, even
  before local provider onboarding. Native requests also clear stale Settings
  searches, so the requested page actually becomes visible.
- A page outside the declared local origin receives no `environments`,
  `remoteClient`, `computerSharing` or Node bridge. Its workspace facade rejects
  add/open calls without user activation. These preload checks do not replace
  the production main process's independent sender checks.
- Computer access starts off, selected folders start read-only, cancelled
  confirmation grants nothing, and Stop sharing immediately updates the state.
- With the feature flag absent, no sharing controls appear, including through
  an old post-pair deep link. The smoke then explicitly enables the flag only
  in its disposable server to exercise the unfinished feature's enabled path.
- The post-pair deep link opens access for the correct saved workspace. Hosted
  renderers receive **no** `computerSharing` permission bridge.
- A real pairing exchange sets Chromium's HttpOnly session cookie. The native
  connector registers with the real fixture server using `session.fetch`, then
  revokes the registration. Its cookie is never copied into renderer JavaScript.

The printed evidence directory retains `receipt.json`, `electron.log`, and
desktop/narrow/in-app screenshots. Successful cleanup removes only the
temporary home, profile and server data. Expected fake IPC rejection messages
appear in the log.

This verifies actual renderer/preload dispatch, with fixture IPC handlers
substituting native confirmation, server persistence and navigation. The app
shell uses the supported compact-sidebar preference to avoid unrelated remote
favicons; icon fetching and ancillary shell IPC services are not covered. It does
not prove public DNS/TLS or a live computer-control session. The native
connector portion does prove a real pairing exchange and cookie-authenticated
registration; filesystem and MCP execution are covered below.
Native menu items are selected programmatically; this is not a physical
mouse/keyboard test of the operating system's popup.
The existing production handler still performs native confirmation and opens
the server's pairing page; its URL/state helpers are checked separately with
`node --test electron/environments.node-test.mjs`. Do not report this offline
smoke as an authenticated connection to a customer's server.

## Official desktop client interoperability

Use an unmodified macOS release from
[the upstream publisher](https://github.com/milind-soni/OpenMausBot/releases),
not the Personal launcher or a locally rebuilt upstream checkout. Record the
release version, archive SHA-256 and `codesign --verify --deep --strict` result.
Launch it with a disposable `--user-data-dir` and `OMB_DATA_DIR`; do not change
`HOME`, which can prevent macOS safeStorage from accessing the login keychain.
Keep the Personal application's profile and server data untouched.

In that official client, open **Server → Connect to a server…**, then the
connection form. Paste the complete HTTPS pairing link, preserving the hostname
and its dots. Before submitting, verify that the form names the server, shows
**HTTPS**, and enables Connect. A successful descriptor lookup is not a pairing
exchange: do not report it as an authenticated connection.

For an exchange test, start `launchVerificationServer` from `scripts/control-omb.ts`
with its `staticDir` argument set to a built Personal UI. Create a short-lived
client-scoped pairing offer only on that isolated server, paste its full link in
the official client's form and click Connect. Confirm navigation to the fixture
workspace, a rendered bot list and `/api/auth/session` returning `kind: "session"`
with `scopes: ["client"]`. Never print the code, session cookie or token. Quit the
verification client and stop the fixture afterwards.

Qualification on 2026-11-12 used the signed upstream arm64 release **0.1.154**
(archive SHA-256 `18ae1df847f72cb213524762e326004a09d9242578d8638cfc7e35e8accc19fa`).
The real custom HTTPS endpoint was recognized and Connect was enabled. The
separate isolated fixture completed the official client's code exchange,
workspace navigation and client-scoped session check. These are separate
results: they do not establish an authenticated exchange over the public tunnel
or native iPhone connectivity.

## User flow

In a desktop build with this feature, choose the server dropdown above the
sidebar search → **Connect to a server…**, or open **Settings →
Servers**. Enter the server's HTTPS address or full pairing link and an
optional name. Confirm the host in the native dialog, then complete pairing or
email sign-in on that server. To generate an owner link without the CLI's
phone wizard, run `npx openmausbot pair --label "My desktop"` on the server.
Treat this link as a secret. Existing limited-access links retain their limits.

Select **This computer** or a saved hosted workspace to switch. Each origin
keeps its own session, bots, chats, provider credentials and settings. **Forget**
signs this desktop out and removes its saved connection, not the server's bots
or data. The server must remain running independently.

The dropdown renders in the server's own UI, so both desktop and hosted UI
need the update for the in-page control. When connecting to an older hosted
version, the native **Server** menu remains available to switch back or open
local connection Settings. Remote pages cannot enumerate the desktop's saved
connections or directly invoke switching, forgetting, or host-only controls.

## Optional computer sharing

**Computer sharing is disabled by default.** The exception is a Mac lending
itself to the person's own Clouds, which happens by itself with a gate of its
own; see `docs/cloud-pro.md`, "This computer works for your Clouds".
Connecting and switching hosted workspaces still works, but does not offer
local file, terminal, or screen access. The flow below is maintainer-only
verification with `features.sharedComputers: true` on both servers, not a
recommended production setup or a Settings switch.

After pairing or signing in successfully, a native **Share this computer?**
dialog offers **Choose access** or **Not now** (the default). This choice is
remembered for that workspace identity and paired session, not repeated on
every switch. A different sign-in or server identity requires a new review.
Older servers need updating before they advertise this capability.

**Choose access**, or **Settings → Servers → Computer access**:

- Pick specific folders. They start read-only; **Allow edits** permits create
  and hash-guarded overwrite, not delete. Paths stay inside the chosen folder;
  symbolic/hard links and the desktop's own credential/profile storage are
  refused. Files are limited to 256 KiB per operation. This is a file-transfer
  interface, not a mounted filesystem or a sandbox for hostile local processes.
- **Unrestricted terminal** is a separate, broad opt-in: commands run as the
  desktop user and can read/write/delete outside those folders, including
  credentials. No inherited API-key environment or shell startup files; that
  does **not** confine commands. Maximum 30 seconds and 256 KiB output per call.
- **Computer control** is a separate broad opt-in: the official local Cua MCP
  can observe and operate logged-in apps, outside shared-folder boundaries.
  Local control and OS permissions must already be enabled. A local resource
  lease prevents concurrent calls with local bot turns and honours human holds.
  Between calls, another actor can change the screen: observe again before acting.

Saving requires a native confirmation naming the exact HTTPS workspace and
permissions. Shared content may reach that server's model provider. Nothing is
granted merely by connecting the workspace.

**Whose bots can use it.** A lent computer belongs to the person whose paired
session registered it. On that server, only a conversation that person started
(their own message, from a signed-in or paired session, started the turn) can
list or use it; continuations of that same request keep it. Another person's
conversation, a routine, a webhook, a room, a bot's delegated or peer turn and
the machine's own owner at loopback see no computers, and a known computer id
answers exactly like an unknown one. Entries are keyed by the registering
session, so no other session can take over or squat an id. The server also
refuses any operation outside the scopes the desktop registered, before
queuing it; the desktop still checks every operation against its own grant.
A bot whose **Computer** setting is off cannot use lent apps and screen.

**What folder access never reaches.** Besides the desktop's own data and grant
store, no folder operation (read, list or write) reaches the person's keys and
sign-in stores or places that run code by themselves, however the folder
around them was chosen: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
`~/.docker`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`,
`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/{gh,gcloud,op,git,fish,
autostart,systemd}`, browser profiles, `~/Library/{Keychains,Cookies,
LaunchAgents,Safari}` and `~/.local/bin` (the list is
`PERSONAL_SECRETS` in `electron/shared-computer-access.mjs`). A listing shows
them as `protected`. Writes are refused inside any `.git` directory, because
git runs commands from its configuration and hooks. Other files that programs
later run (scripts, build files) can still be edited in a writable folder.

**Computer control** offers only on-screen tools and, for each, only the
arguments that observe or operate the screen (`LENT_SCREEN_ARGUMENTS` in
`electron/lent-screen-tools.mjs`, derived from the driver's own schemas and
checked against a snapshot of them in `electron/fixtures`). The local driver's
other tools (uploading a local file into a page by path, recording or
replaying to a path, changing or updating its configuration, installing a
binary, opening a DevTools port, killing a process, raising permission
prompts) are refused and hidden, and so is every argument that names a file
(`screenshot_out_file`, `debug_image_out`, `image_path`, a path as a cursor
icon or as a URL to open), a command line or a port. Unknown arguments are
refused, never forwarded.

**Activity log.** The desktop records every request it receives (time, server,
action, folder name and relative path, tool name or command text, and whether
it ran or was refused) in `lending-activity.jsonl` next to the grants, owner
only. It only ever appends (never through a link); a full file of 500 entries
is moved aside intact as `lending-activity.jsonl.1`. It never records file
contents, output or typed text.
**Computer access** shows the recent entries for that server.

The connector runs in Electron main, outbound to the paired server; there is
no exposed local listener. Every request needs the live paired session plus a
separate connector secret. The desktop—not the server—checks each operation
against local grants. Grants are local, owner-only files and contain no pairing
code. File grants cannot expose Electron profile storage, including these grants.

Agents use `list_shared_computers` then `shared_computer`. They receive folder
IDs/names, not local absolute paths. A bot's turn capability must still be live
when a request is delivered and while it runs. Offline or uncertain operations
are never automatically replayed, and never fall back to the server filesystem.
Server restart clears the in-memory queue; the desktop reconnects without
replaying actions. Polls do not hold the workspace-backup maintenance gate.

Access persists across workspace switches while the desktop is open. **Stop
sharing**, **Forget**, revoked pairing, or closing the desktop stops the
connector. Running commands are cancelled where possible; a native action
already admitted by Cua may have completed. Inspect uncertain outcomes before
retrying. A sleeping/offline laptop cannot service requests.

The local feature flag is rechecked before reconnecting a saved grant,
accepting consent, dispatching a remote job, and on the existing one-second
job lease. A disabled or unreachable local server aborts the connector;
an in-flight check may take up to its three-second request deadline. Restart
the desktop after re-enabling the flag. Turning it off does not erase grants,
and a native operation already admitted may have completed.

## Connector and authority tests

```sh
pnpm exec vitest run server/shared-computers.test.ts server/shared-computers.e2e.test.ts server/shared-computers.gate.test.ts
node --test electron/shared-computer-access.node-test.mjs electron/lending-guards.node-test.mjs
```

The **Shared terminal smoke** workflow runs the native terminal tests and this
real-connector test on Windows. It covers ordinary cmdlets, quoted and Unicode
command text, leading declarations, pipelines, return/exit status and process
revocation. Windows PowerShell prioritizes its own modules while retaining the
rest of its resolved module search path. No new command restrictions or approval
prompts are introduced; the existing grants, timeout and cancellation remain.

The end-to-end test starts a **real isolated server**, pairs a desktop, opens
a fake-model turn, and launches the **real agents MCP process** with that
turn's capability. It reads/edits fixture files and runs a harmless terminal
command through the real outbound connector. It checks read-only denial,
traversal denial, per-session/secret ownership, cookie CSRF, local-control gate
rejection for remote sessions, in-flight revocation and durable access-off.
It writes a redacted receipt beside the fixture server log.

Unit tests cover turn cancellation, offline sessions, one-job delivery/no
replay, host-screen resource leases and human takeover, path/link/size limits,
protected desktop storage, terminal cancellation, and the persistent official-
style Cua MCP handshake/image transport using a stand-in. They do not operate
the user's screen or prove real Cua actions on each supported OS. No live VPS,
public HTTPS, Windows desktop, or macOS screen permission was exercised by this
recipe. Run those release smoke checks separately before claiming coverage.

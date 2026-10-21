# Personal: fixed native Codex threads

Settings → Codexセッションへの接続 stores owner-only mappings in
`private/direct-codex.json`. Each mapping names an existing Bot, Bot thread, local
host and existing native Codex thread. Different Bot threads can use different
native sessions. The existing native model, instructions, context, working folder,
permissions and tools are not replaced by Bot configuration.

The direct branch runs before OpenMausBot context replay, compaction, prompt
construction, tool mounting and model execution. It submits the canonical user's
text through `thread/resume` and `turn/start`, with a stable client message ID.
Neither text nor native session IDs are logged by that branch. The native writer
is unsubscribed and the child process is closed after each turn. Writer conflicts,
unknown delivery state and disconnects are visible and never automatically replay
the input, fork the conversation or fall back to the Bot harness.

Queue submissions remain separate native user turns; they are not coalesced into
a Bot prompt. Existing send ID deduplication and the normal Stop/approval routes
are retained. Native command/file approvals require a live explicit response;
the bridge does not grant a session-wide approval. A single native user question
is forwarded. Standalone connections stop on unsupported requests; shared
connections leave multi-question, app-host and other unsupported requests to
the desktop subscriber rather than inventing answers or alternate execution.

The original native answer is stored alongside the displayed answer. Optional
formatting is an asynchronous, independent tool-free request containing only that
question and answer. `codex-native` uses the existing native Codex login and the
tool-free, ephemeral `runCodexOneShot` helper with the selected model (default
`gpt-6-luna`). Other configured providers with a text-generation helper can be
selected by instance ID and model. Failure or timeout retains the original.
Formatted text is never sent back into the native session. The UI offers the
original answer below a successfully shortened response.

Optional `mediator` configuration adds a separate tool-free preparation request
before the destination receives input. It uses the selected provider and model
(default `codex-native / gpt-6-luna`) to produce a bounded clarification note.
The original user input remains intact in the submitted JSON; the model cannot
choose or change the destination. Failed or timed-out preparation sends nothing.
Delivery errors and empty answers are never automatically retried. This is
distinct from optional `formatter` configuration, which runs after the answer.

Enabled mappings poll native history every 15 seconds, using only read APIs.
New completed app-side user and assistant messages are imported once; assistant
messages may be shortened locally. Initial attachment starts at the latest turn
and does not import the old conversation. A missing checkpoint in the newest 50
turns reports `history-gap` rather than silently skipping missing history.

## Verification

```sh
node node_modules/vitest/vitest.mjs run server/direct-thread-bridge.test.ts server/direct-codex-client.test.ts server/direct-codex-service.test.ts server/codex-relay-mediator.test.ts server/codex-relay-session.test.ts server/direct-codex-formatter.test.ts src/components/DirectCodexSettings.test.ts server/steer-queue.test.ts server/routes/bot-messages.test.ts --maxWorkers=1
node --experimental-strip-types scripts/direct-codex-acceptance.mjs
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -b
```

The acceptance fixture uses `verificationServerEnvironment`, separate temporary
homes and ports, fake Claude/native CLIs and a fake formatter. It sends through the
normal HTTP message routes, including queued input, and checks native payloads and
history. It never uses live credentials, Google Chat, real Bot data or a real AI.
`OMB_DIRECT_FIXTURE_SERVER` selects a packaged server for the same acceptance run.

## Operational limits

A standalone native process cannot resume the desktop-owned writer. Production
now shares the desktop's actual runtime through `app-owned-codex-wrapper.mjs`
and `app-owned-codex-proxy.mjs`. The launcher execs the genuine CLI as the
desktop's direct child and retains its original config/environment; a separate
child forwards stdio over the private Unix socket. Extra app-server invocations
with an explicit transport pass through unchanged. This preserves the app's
existing peer authorization, which rejected a nested Node wrapper.

The installed M1-to-original text path, actual app-host tool call, synthetic
file write/read, and reverse native-to-M1 input/answer import have passed live
checks. ChatGPT's approved read API confirms the same history; its GUI rendering
is not agent-verified because Computer Use prohibits that app. The original
full-access policy remains unchanged. A separate synthetic session on the same
actual runtime verified one-time approval and duplicate rejection.

This implementation supports local, plain-text, ordinary user turns. Attachments,
quoted/data context, edits/retries of old turns, mid-turn steering, routines, cloud
execution and Bot delegations are refused for bound threads. Host-app-only tools
are unavailable to a standalone native CLI. Existing Bot histories stay in
OpenMausBot and are not injected into the native conversation. Privacy Filter is
not a boundary for native CLI file, browser or network operations.

## Earlier fork alternative (not the active production configuration)

The 2026-10-20 native experiment `probe-mediated-fork.mjs` created an ephemeral
fork of the existing M1MacControl using the official `thread/fork` API. It did
not resume, unlock, archive or change the original. Two real requests passed
through Luna preparation, native Codex execution and Luna display formatting.
The second request recovered a synthetic term from the first request without
including that term in the second submitted input. The original's latest turn
IDs were unchanged. This proves the alternative's model/data path, not live
installation or simultaneous sharing of the original desktop session.

For lasting use, create a **persisted, clearly named execution copy**, pin a Bot
thread to that new ID and enable `mediator` and optionally `formatter`. Use the
Personal/phone interface for that execution copy; opening the same copy in the
ChatGPT app can create the original writer conflict. The original M1MacControl
can remain open independently. History is inherited at fork creation; later
changes are separate and are not bidirectionally synchronized. Both the Bot
thread and execution copy must be explicitly chosen before production routing
is changed. That alternative was not selected; production instead retains the original ID using the shared desktop runtime.

Provision a persisted execution copy with the native login, without editing the
source model, permissions or original history:

```sh
node scripts/create-codex-relay-session.ts --source SOURCE_THREAD_ID --name 'M1 実行用' --report /private/tmp/omb-new-relay-receipt.json
```

The report path must be new. It records an uncertain failure and does not retry
fork creation automatically. Record the returned thread ID, then explicitly
select it in the owner's connection settings. An existing fixed binding must
first be removed and saved before attaching that Bot thread to a different ID.
Enabling `mediator` and `formatter` produces the Luna → native session → Luna
path. Do not reuse the original desktop-owned ID for this alternative.

`probe-persisted-relay.mjs` additionally verifies a named persisted fork using
synthetic data. Two independent native processes recover a term inherited from
the source while that term is absent from both submitted requests. Test
conversations are archived afterward. This covers process restarts as well as
the in-memory fork experiment above.

`probe-packaged-relay.mjs` runs the packaged server with isolated Bot data,
the existing native login, and a synthetic persisted native fork. Two ordinary
HTTP sends traverse actual Luna preparation, native execution and actual Luna
display formatting. It restarts the fixture server between sends and checks
both native payloads and retained context. The synthetic original is unchanged;
both test sessions are archived afterward. This proves the packaged alternative
without activating the production M1 mapping.

The owning app's `send_message_to_thread` route was also checked. It accepted a
synthetic request, stored a `codex_delegation` function-call output, and produced
an empty final answer in the existing target. A fresh ephemeral Luna session
answered both ordinary and tool-output forms correctly. Therefore delegation
format alone does not explain the existing target failure. The exact interaction
between its stored context/configuration and the desktop runtime remains
unresolved; acceptance is not treated as successful delivery-and-response.

## Shared runtime retaining the original native thread

`CodexSharedClient` connects through an owner-private Unix socket. The configured
link, its parent, the resolved socket and its parent must belong to the current
user; both parent directories and the socket must exclude other users. Codex
0.163.0-alpha.10.2 creates a Unix socket alias pointing into its private daemon
directory, so the client validates both endpoints and connects to the resolved
socket. It never opens a public TCP listener or falls back to stdio after a
configured shared connection fails.

Set `OMB_NATIVE_CODEX_SOCKET` explicitly in fixtures. Production uses the private
`$CODEX_HOME/openmausbot-shared.json` file:

```json
{"version":1,"managedBy":"openmausbot-personal","socketPath":"/Users/you/.codex/omb-shared/control.sock"}
```

Both ChatGPT desktop and Personal must use that same runtime. The installed
desktop build `26.1013.40934` has an internal `CODEX_APP_SERVER_WS_URL` transport
override; `ws+unix://localhost/absolute/socket.sock:/rpc` selects its bundled Unix
WebSocket support. This is not claimed as a public stable desktop setting.
An isolated launch of the actual desktop binary initialized the configured
transport as `Codex Desktop` using an empty profile and empty native home.
No screen inspection, GUI automation or credential copying was used.

Enabled shared bindings retain a subscriber for their original thread. App-side
user inputs are imported as accepted; completed native answers are synchronized.
Command/file approvals and single user questions can be answered through M1
even when the turn originated in the desktop app. Duplicate requests from
multiple connections create one M1 card. Native resolution or turn completion
expires stale cards. An approval is always per action, and another client's
resolution prevents a second response. Client shutdown unsubscribes only that
connection; it does not kill the shared server.

The earlier standalone shared server was managed by `scripts/shared-codex-host.mjs`, without model,
permission, hook or tool overrides. The activation script preserves the existing
M1MacControl ID, enables Luna preparation/display formatting, backs up the
installed Personal app and connection settings, and checks that Privacy Filter
settings are unchanged. It refuses activation while ChatGPT remains open or
Personal has active work. That initial standalone LaunchAgent is now disabled. The current login item only
restores the verified desktop CLI override; the desktop owns the live server. Authentication
stays in its existing native home; no authentication file is copied or edited.

```sh
# The initial standalone activation is an earlier installation stage.
# For the deployed configuration, open ChatGPT and Personal normally.
# Quit ChatGPT and finish Personal work before rollback:
node scripts/rollback-shared-codex.mjs
```

Rollback preserves native conversation history and unrelated current settings.
It refuses to interrupt active native threads or overwrite a later Personal
update. `activation.json` records the backup and launch state; starting both
apps is not marked as successful visual or tool verification.

```sh
node node_modules/vitest/vitest.mjs run server/codex-shared-client.test.ts server/direct-codex-service.test.ts --maxWorkers=1
node scripts/shared-codex-acceptance.mjs
```

The shared acceptance uses a fake native Unix-socket server, isolated Bot data
and the normal HTTP routes. It proves M1-to-app and app-to-M1 approval paths,
expiration after the other client answers, no duplicate permission cards,
app-side history import and app-subscriber dynamic tools, without creating a
different native thread. `OMB_DIRECT_FIXTURE_SERVER` and
`OMB_DIRECT_FIXTURE_UI` run it against a packaged candidate.

Real-model synthetic checks additionally prove two live clients, dynamic tool
results and a once-approved shell write into the fixture's temporary directory.
An intermittent empty final answer occurred after a successful dynamic tool;
this remains a visible failure and is never automatically retried. The normal
successful trial also returned and persisted its final answer. Actual desktop
startup, model/tool protocol checks and synthetic HTTP tests are separate
evidence; they do not establish the final production GUI workflow by themselves.


## Current production startup

The desktop-owned mode requires ChatGPT and Personal to stay running. A private
login helper validates the wrapper/proxy hashes before restoring our
`CODEX_CLI_PATH` override; it starts no apps. After a desktop update, repeat the
actual-desktop transport and app-tool checks. The old standalone LaunchAgent is
disabled. The runtime's close is not a signal to replay any unfinished request.
The source original, provider selection, native model and permissions are never
replaced to recover a connection.

`probe-app-owned.mjs` launches the actual desktop with empty native home/profile
and no authentication copy. Its private socket and app-tools catalog checks
passed. `probe-live-approval.mjs` requires a terminal preserving stdin; inspect
the printed synthetic command before sending `accept`. It creates and archives
only its own test session, and does not alter the original's permission profile.

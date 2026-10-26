# Native OhMyPi transport

For the shared standard TUI connector and the NativeConect definition, see
[NativeConect](../nativeconect.md). `connection: "shared-tui"` attaches through
standard Collab instead of starting an independent RPC session writer.

The Personal build exposes `/api/native-omp` for owner-managed, per-Bot
OhMyPi NativeConnect destinations. Each Bot thread derives a separate remote
session directory by default, or explicitly selects a catalogued native session.
The mediator prepares a short note while preserving the
original request; display formatting is independent of native history.

## Session management

Personal Settings → General → OhMyPi / NativeConnect selects a Bot, its OMB
thread, and a native session. The management option covers the configured OMP
profile's catalog, creation and binding; it does not merge project transcripts.
The catalog reads bounded headers under the configured state root, its sibling
`project-threads`, and that profile's native session directories. An arbitrary
external session directory is not accepted from the model.

The same tool-free mediator interprets ordinary chat instructions as bounded
list/create/connect/manager operations. For example, ask to create a named
project session and connect a new OMB thread, select an existing named session
for the current thread, or create a session without changing any OMB thread.
These are semantic intents rather than exact command phrases. A new OMB thread
requires an explicit quoted span of the user's instruction. Ambiguous names
require an ID or an exact unique name; no arbitrary selection is made.

`GET /api/native-omp/sessions` lists the native catalog. `POST` creates a named
empty persistent session with a request ID. `POST /api/native-omp/threads`
validates a real shared connection before committing the thread target. All
routes retain the normal authenticated owner boundary. The private management
journal reuses a partially created native session and OMB thread on retry.
Creating a native session uses standard RPC `new_session` and `set_session_name`,
without a model prompt. Normal work continues through the native standard TUI.

The connector accepts native sessions which have not yet saved a JSONL file.
When multiple saved sessions share a directory, pool ownership, private relay,
tmux name and lock are scoped to native identity. Existing legacy private
relays are discovered and reused. Multiple OMB views of one native session
share an input queue and expose each approval in only its owning view.

An already running unshared TUI can be adopted through its standard `/collab`
command only when its tmux client is detached and its composer is proven empty.
A draft, dialog, unknown writer or attached human TUI refuses adoption without
clearing input or restarting it. Enable native Collab there or detach after
finishing the draft, then reconnect. Public relay destinations are unsupported.
At most eight native processes in the configured profile may be started by
this connector; it does not kill or silently recycle existing sessions.

Additional checks:

```sh
node --test scripts/native-omp-pool.node-test.mjs
node node_modules/vitest/vitest.mjs run server/native-omp-sessions.test.ts src/components/NativeOmpSettings.test.ts
```

The HTTP fixture covers idempotent session creation, selecting an existing
native session, chat-driven creation plus a new OMB thread, round-trip input to
that selected native session, save-only creation without an extra thread, and
rejection of malformed management output before any native prompt.

On 2026-10-26, isolated Pi sessions also verified native TUI human input mirrored
to two OMB views, serialized OMB submissions, connecting an empty unsaved native
session, preserving a draft during refused adoption, adoption of the same TUI
process without a model prompt, and two distinct sessions in the same directory
with independent answers and no crossed history. These synthetic sessions used
the installed OhMyPi 18.12.5 binary and existing Pi authentication. They did not
execute or resend a production Bot request.

Run the synthetic stdio/SSH-plan checks without provider credentials:

```sh
node --test scripts/native-omp-transport.node-test.mjs
node --test scripts/native-omp-collab.node-test.mjs
node node_modules/vitest/vitest.mjs run server/native-omp-review.test.ts server/native-omp-service.test.ts
./node_modules/.bin/oxlint --deny-warnings scripts/native-omp-transport.mjs scripts/native-omp-transport.node-test.mjs
node scripts/native-omp-acceptance.mjs
node node_modules/vitest/vitest.mjs run server/native-omp-service.test.ts server/direct-codex-service.test.ts server/codex-relay-mediator.test.ts --maxWorkers=1
```

The transport checks cover source-thread pinning, SSH command/path validation, v2
negotiation, persistent conversation selection, exact input, request-ID
deduplication within one transport lifetime, concurrent-turn refusal, native
prompt completion versus background-work settlement, provider failure,
disconnect, timeout, human-question expiry, unsupported-question denial,
Mac host-tool refusal, UTF-8 chunk assembly and native abort dispatch.
The HTTP acceptance launches a real server with an isolated home, a synthetic
mediator and a synthetic native peer. It covers source preservation, native
history, independent short display, per-thread separation, queueing,
confirmation/select approvals, questions, Stop, provider failure and an
unrelated ordinary Bot. No real account or Raspberry Pi is contacted by it.
The service tests additionally prove restart receipts prevent replay and that
Stop settles a preparation model even if it ignores its AbortSignal.
Development approval fixtures cover source/config saves, native hashed
multi-file edits, `.mcp.json`, local API checks, Python diagnostics, unittest and
smoke scripts without new human cards. The native patch must match the edit
dialog exactly; a missing or ambiguous operation retains confirmation. Source
is refreshed after edits, bounded to the destination workspace. Reader tests
cover symlink/escape/private-file/oversize/FIFO rejection. Service tests prove
same-request human approval context is retained and a human takeover during
review prevents automatic authorization. Native safety reasons, privilege and
service changes, unknown execution effects and failed reviews retain cards.
The tool-free live Luna regression uses fictional NAS code and executes no
tools; it separates saving network code from actually invoking a device.

Shared approval checks also cover questions arriving outside an OMB turn,
startup replay of native pending questions, and approvals after a failed turn.
Waiting for a native human turn or an Allow/Deny response does not consume the
execution deadline. A disconnected prompt still in the local queue is recorded
as not sent, while an accepted prompt is never replayed automatically.

The protocol contract is [OhMyPi RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).
Only a `prompt_result` with completed status and a settled native session can
finish a successful request. An acknowledgement or `agent_end` is insufficient.
Unknown/disconnected operations must not be replayed automatically.

Before enabling a real Bot connection:

1. Confirm SSH access using the intended Pi account and existing host key.
   A Tailscale policy refusal is a blocker, not a reason to try a bypass.
2. Read `/etc/os-release`, `getconf LONG_BIT`, `uname -m`, installed runtimes,
   memory and disk availability. Do not infer a 64-bit userspace from the board
   model or kernel alone.
3. Inspect and pin the official OhMyPi release, install into the Pi user's
   own directory, and verify the actual executable and RPC protocol version.
   Existing model authentication is to be used on the Pi; do not copy the
   Mac's credentials silently or print credential contents.
4. Use the service's private durable request ledger. Transport-level request
   deduplication alone is in memory; the service refuses existing request IDs
   after restart, including requests whose completion was indeterminate.
5. Route questions/approvals through authenticated human events. The mediator
   must never receive a tool that can approve its own native operations.
   The transport supports confirm/select/input/editor and blocks unsupported
   dialog methods. The service uses the normal authenticated Bot response
   cards. Native tool-select approvals expose only Allow/Deny, mapping Allow
   to the native `Approve` option rather than its session-wide grant option.
6. Exercise the assembled workflow in a disposable OpenMausBot fixture using
   a fake native peer, following `docs/verification/README.md`. Confirm Bot
   scope, thread isolation, reconnect, Stop, approvals and failure display.
7. Test a harmless synthetic read and a synthetic file in an isolated Pi
   test directory, then enable only the selected Bot after saving its existing
   configuration. Do not modify M1's connection or enable Privacy Filter.

Closing a failed SSH connection cannot prove that already accepted remote
work stopped. Stop dispatches native `abort` and waits up to five seconds for
the native aborted result before closing. An incomplete native turn is never
reported as successful and is never automatically replayed.

## Initial qualification, 2026-10-21

The Raspberry Pi 4 4GB ran Debian 13.3, aarch64 with 64-bit userspace. The
official OhMyPi v18.12.5 ARM64 release was checked against its published
SHA-256 and installed into a dedicated user-owned version directory. A new
`omb-native` profile was signed in to ChatGPT on the Pi without copying the
Mac's credentials.

A synthetic confirmation word survived SSH disconnection and native session
resumption with the same native ID. Observed initialization/resumption times
were 9.134/7.583 seconds; model reply times were 1.885/2.533 seconds. A single
synthetic file write required the actual native select approval, was allowed
once for that exact path/content, and was verified by reading that fixture
file. That run measured approximately 225 MiB RSS at readiness (not peak RSS)
and 4.654 seconds for the write/approval turn plus verification. These are
individual observations, not throughput or capacity benchmarks.

Packaged Personal deployment and actual Bot UI checks are recorded separately
in `.privacy-dev/raspberrypi-native-connect/report.md`. Do not infer them from
the native transport tests or this initial qualification alone.

## Current scope

- Plain chat text only. Attachments, routines, delegated turns, edited reruns
  and native steering are blocked; queued user turns remain separate.
- Pi file/shell tools only: read, bash, edit, write, grep, glob and ask. Native
  extensions, automatic skills/rules and LSP are disabled for this profile's
  relay invocation. Browser/desktop control is not qualified.
- The original native answer stays in the local message store and the native
  Pi session; the formatted answer never becomes Pi conversation history.
- The native session must retain its identity. A changed native ID requires
  owner review rather than silently switching to a fresh conversation.
- Inference uses the selected remote model. The disabled Privacy Filter is
  not re-enabled by NativeConnect, and this is not an egress masking boundary.

## Shared connection recovery

The OMB guest keeps the private relay and SSH tunnel alive when the native host
rotates its Collab room. It requests a fresh link from the same native host, checks
the pinned session identity, and reads the new snapshot. A submitted prompt is
never sent again. A missed terminal answer can complete the original turn only
when its own native admission and an idle native state are established; concurrent
human input still marks the result as shared. Invalid encrypted frames, a foreign
session, and native execution errors do not become successful recovery.

Relay heartbeat retires silent sockets so an old host connection cannot prevent
room reclamation indefinitely. A lost SSH process is replaced with bounded-backoff
reader reconnection; this imports missed native history without calling the
mediator or submitting a prompt. Shutdown cancels those retries, and stale readers
cannot append history or change the replacement connection's state. Important
operations retain the existing human approval policy.

Run `node --test scripts/native-omp-collab.node-test.mjs` for the real loopback
WebSocket rotation, missed-answer, foreign-session and silent-host regressions.
The service tests also check background reader recovery without prompt replay and
shutdown cancellation. These are synthetic tests; deployment still requires a
read-only check of the intended native session and preserved history.

### Japanese questions and interrupted-request ownership

Native tool approval descriptions use Japanese labels while preserving the exact
command, path and content. Ordinary select/editor questions use structured question
cards, with a separate tool-free translation call and a mapping from Japanese display
labels back to the original native option. The translation cannot approve an operation.
If translation fails, the card explicitly reports that failure and retains the original
for inspection; it never invents an answer. Native approvals still permit only a
one-time grant. Closed-source phone clients may retain their own English button labels.

The known OhMyPi 18.12.5 developer-report confirmation is answered No, and writes to
`xd://report_issue` are denied, without asking the owner to approve an unsolicited
external report. Other Yes/No questions retain the normal human response path.

An admitted native input is linked to its durable receipt by native entry ID. After a
disconnect, the same native history can restore low-risk review context without a new
prompt. A later human input clears that context. Only a linked final assistant entry
and idle state can reconcile an interrupted receipt as completed. Ambiguous identical
inputs are not guessed. Native host error frames are operation notices, matching the
standard pinned guest; they do not detach an already admitted prompt. Room resync
retains an unchanged pending question rather than cancelling and recreating its card.

The service/question/review regressions and loopback Collab tests cover these cases.
`node scripts/native-omp-acceptance.mjs` additionally drives translated structured
answers, one-time permission and developer-report decline through isolated HTTP routes.

### 2026-10-25 recovery qualification

The native session had finished the request while OMB showed an indeterminate
result. Its TUI recorded a Collab send-backlog overload and loss of sharing. The
updated reader rejoined the same native session and read the missing terminal
answer without submitting a prompt. Personal imported that answer exactly once
and returned to idle. The original failure remains in history rather than being
erased or silently reported as an originally successful delivery.

37 transport/Collab tests, 41 service/review/M1 regression tests, source ratchets,
isolated HTTP acceptance, and the packaged-server smoke passed. An actual Pi
read-only connection and the Personal UI verified recovery. Live in-flight room
rotation was not injected into the user's session; that path was exercised with
real loopback WebSockets and synthetic native entries.

The runtime-only update preserved the fixed launcher, M1/Pi identity and approval
settings, Google Chat and registered-word settings. All 2,941 existing messages
retained their IDs, text and JSON; the recovered answer was the only added message.
The per-thread update time advanced. Evidence and rollback copies are under the
Git-ignored `.privacy-dev/native-omp-recovery-20261025/` directory.

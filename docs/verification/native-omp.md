# Native OhMyPi transport

For the shared standard TUI connector and the NativeConect definition, see
[NativeConect](../nativeconect.md). `connection: "shared-tui"` attaches through
standard Collab instead of starting an independent RPC session writer.

The Personal build exposes `/api/native-omp` for owner-managed, per-Bot
OhMyPi NativeConnect destinations. Each Bot thread derives a separate remote
session directory. The mediator prepares a short note while preserving the
original request; display formatting is independent of native history.

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
Mediator review checks cover read-only inspection, independent low-risk verdicts,
native full-title Collab requests, owner-only destructive actions, failed reviews
and a human answering during an in-flight model review. HTTP acceptance also
checks automatic inspection approval and refusal to auto-answer a formatting
request; the destructive command is only fixture text and never executes.
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

# NativeConect

NativeConect is OMB-side mediation of an existing harness's ordinary input and
output. The destination still receives a normal prompt and produces its normal
answer, progress and history. OMB reads those existing outputs and may format a
copy for chat. It does not require a destination-specific output prompt, a new
destination agent loop, or a second copy of the conversation.

Lightweight model choices belong to OMB: organizing context, selecting a pinned
destination and presenting replies. They do not approve operations or execute
the destination's tools. A connector adapts the harness's existing input,
history and approval interfaces. Replacing the harness requires a corresponding
connector rather than changing this definition.

## Standard OhMyPi TUI

The optional `connection: "shared-tui"` binding uses unmodified OhMyPi v18.12.5
Collab. One standard TUI, retained in a named Pi tmux session, owns the native
history writer. OMB attaches as a normal Collab guest. The human attaches to
that same TUI; starting another `omp --continue` against its file is not a
supported way to share it.

OMB sends the original prompt text without its former request/mediator JSON
envelope. Collab attributes it as a user input, with an OMB participant badge
for display. OMB reads the standard replicated session entries, events and
questions. Human TUI inputs and native answers are mirrored into the OMB thread.
Original native answers remain available in message metadata; asynchronous
display formatting never changes the native transcript.

Connect from a Mac terminal after starting Personal:

```sh
node /Users/sora/Code/OpenMausBot/scripts/nativeconect-terminal.mjs --bot RaspberryPi
```

Pass `--thread THREAD_ID` for another explicitly selected Bot thread. Detach
with **Ctrl+B, then D**; this leaves OhMyPi running. The connector validates the
SSH destination and uses the existing host key. The TUI itself remains usable
when OMB is disconnected, and its subsequent entries are synchronized when OMB
reattaches. Personal must be running for OMB-mediated input and live mirroring.

## Concurrent input and failures

OMB waits while the host reports a streaming turn, queued input, abort or an
unresolved question. One OMB turn is admitted at a time per thread; existing OMB
queues handle additional chat inputs. A prompt is sent atomically as one native
Collab frame, so it cannot mix with characters in the human's draft composer.
Native TUI submissions retain OhMyPi's normal queuing/steering behavior.

There is no distributed compare-and-swap around a TUI keystroke and a Collab
prompt. If inputs cross that boundary, OhMyPi handles its native ordering. When
an additional human input joins the same observed OMB turn, OMB labels the answer
as a shared turn and does not claim it answers only the BOT input. Stop does not
send a shared-host abort when it could interrupt a concurrent human turn.

Collab's first human response to a question wins and dismisses the other views.
OMB exposes one-time approval, never session-wide approval. A disconnected or
uncertain request is not resent. The existing durable receipt prevents automatic
replay after restart. Native session identity is checked before history import.

The relay listens on Mac loopback, is reached from Pi only through a loopback
SSH reverse forward, and carries standard AES-GCM Collab payloads. It does not
use the public relay. Capability links stay in process memory and are not
logged or saved to Git. The relay is an OMB implementation of the documented
Collab routing contract, not the vendor's production relay distribution.

## Limits

The shared connector currently handles plain text and standard select/editor
questions. Attachments, OMB routines, delegated turns and edited reruns retain
their existing blocks. It reads normal native turn output and idle state; this
does not prove all independently launched background jobs or a native goal
have finished. Use Personal Settings → General → OhMyPi / NativeConnect or an
explicit chat instruction to select an existing session, create a named session,
or create and connect a new OMB thread. Native session switches/branches require
an explicit binding; OMB never silently follows them. The OMP management option
handles sessions within the configured profile and keeps project histories
separate. See [session management verification](verification/native-omp.md).
Unsupported dialogs,
protocol mismatches, another detected session writer, or lost connectivity
stop the connection without a raw-input fallback.

Privacy Filter remains an independent setting. NativeConect does not enable
masking when that setting is OFF.

## Mediated approvals and native review

The owner can set `approvalPolicy: "mediator"` on a Pi binding. OMB detects
high-risk operations, rather than proving each operation belongs to a low-risk
allowlist. A valid `highRisk: false` verdict proceeds through the native
one-operation Approve. A concrete `highRisk: true` finding creates a Japanese
owner card identifying the affected target and significant effect. Native
safety reasons, privilege/disk changes, service/network changes, major deletion
and credential exposure have explicit high-risk checks. Default bindings still
use `human`; the high-risk-only mode is the owner's opt-in mediator policy.

Unlisted commands, unfamiliar file extensions, paths outside the workspace,
missing complete source and incomplete patches are not themselves high-risk
findings. The tool-free classifier uses the actual native request, matching
operation metadata when available, fresh bounded source evidence, the user's
purpose and earlier approvals for the same request. Its only supported verdicts
are `{"highRisk":false}` or `{"highRisk":true,"reason":"具体的な危険の説明"}`.
Legacy allow/low replies, invalid replies, model failure and timeout produce no
approval and no owner permission card. The same pending operation is retried
with backoff; cancellation, native answers, human takeover and shutdown stop
that review. This does not grant session-wide approval or replay a prompt.

Before review, recent workspace source can be read over SSH, bounded to twelve
regular UTF-8 files, 32 KB each and 96 KB total. The reader rejects symlinks,
private credential paths, escapes, oversized and nonregular files. These are
limits on evidence collection, not a file/command permission allowlist.
Automatic risk classification is a model judgment, not an OS sandbox or a
proof of no harmful effects. Concurrent source changes remain possible.

### Explicit permission for one request

An authenticated owner can send the standalone chat message `すべて許可`
(or `今回の作業はすべて許可します`) to delegate all tool approvals for the
current OMB request to the mediator. It also releases a currently pending tool
approval. If idle, the grant applies to the next request started within ten
minutes. `すべて許可を取り消して` restores high-risk confirmation immediately;
already-started operations are not undone. Completion, Stop, human TUI takeover,
disconnection, restart and a 24-hour maximum lifetime revoke the grant.
It does not cover other threads, subsequent requests, arbitrary native questions,
or automatic developer reports. Quotes, tool output, guarded/relayed sends and
client-only sessions cannot grant permission. No grant is persisted or inferred
from earlier conversation text. A directive embedded in a longer message is not
recognised as a permission control; send the standalone declaration.

Native approval mode stays unchanged. The mediator still classifies each tool
operation and responds with the one-operation `Approve`, never session-wide
approval. With a grant, concrete high-risk findings create a settled Japanese
operation card rather than another question. Cards persist after the final
answer, omit file bodies, redact common credential literals, and distinguish
permission granted, observed start, tool completion/error and unknown outcome.
Exact native call IDs (or a matching bash command in execution arguments) link
execution events to the receipt. Missing/ambiguous events do not prove execution
or its effects; classification failure still retries without execution.

### In-progress display

The connector mirrors public native assistant narration and observed tool
start/end activity into ordinary OMB turn narration. One rolling status row
shows the current operation and recent completed steps. Shared listeners stay
attached after a local job timeout/reconnect so native continuation is visible.
The final native answer is the turn's terminal message; standard chat rendering
folds the intermediate narration on completion. Native thinking content is
excluded. Native background continuation after an already completed request
gets a separate display turn without creating a new OMB thread or native
session. Phone clients receive the same existing message/turn fields; a
physical iPhone rendering check is separate from protocol verification.

Native `attribution: agent` background results do not replace the current
user's review context or impersonate human input. A matching admitted receipt
can restore that context after reconnection, including native background work
following a completed turn. A subsequent human input or cancellation removes
that delegated context. Closing OMB detaches its shared guests without sending
a native Abort; explicit Stop retains its existing behavior.

`advisor: true` additionally configures OhMyPi's native passive Advisor for a
managed standard TUI, using the binding's existing worker model and no backlog
wait. It offers transcript advice separately from the pre-execution permission
review; enabling Advisor alone does not authorize tools. Existing hosts reload
the overlay according to the native runtime; actual Advisor execution must be
verified separately from a saved setting.

Sources: [native approvals](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md),
[Advisor](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md).

Protocol sources: [Collab](https://github.com/can1357/oh-my-pi/blob/v18.12.5/docs/collab.md)
and [wire grammar](https://github.com/can1357/oh-my-pi/blob/v18.12.5/packages/wire/src/index.ts).

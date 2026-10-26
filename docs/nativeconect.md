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

The owner can set `approvalPolicy: "mediator"` on a Pi binding. OhMyPi keeps
its per-operation approval gate. OMB's tool-free mediator reviews the actual
operation against the current request, earlier requests from the same native
session, and approvals already given for that request. Routine source/config
saves, native hashed multi-file edits, local API status checks, tests, shell
pipelines and quoted Python diagnostics are review candidates. Saving code is
reviewed separately from executing it. Registering a known workspace program
in `.mcp.json` is eligible; changing credentials or registering unknown code is
not treated as routine just because it uses that filename.

For native `File:` edit dialogs, OMB requires a unique matching unresolved
native tool call and includes its full bounded patch. Before reviewing an
execution or edit it reads the recent workspace source paths over SSH, rather
than relying on the last complete write before an edit. The reader is bounded
to twelve regular UTF-8 files, 32 KB per file and 96 KB total. It rejects path
escapes, symlinks, private credential paths, oversized files and nonregular
files. Reading this evidence neither executes the project nor submits a
native prompt. Concurrent filesystem changes remain part of the destination's
trust boundary; this is not an OS sandbox or a proof of no side effects.

Only a valid `allow/low` result approves the current native operation once.
Privileged operations, installation, service/network changes, broad deletion,
credential exposure and native safety reasons retain human confirmation.
Unknown effects, missing required source and failed or late reviews also retain
confirmation. A device action is eligible only within the user's requested or
already-approved target and effect; permission does not expand to another
machine or secret transfer. Review calls have no tools, use the configured
mediator, and allow up to 45 seconds within its configured timeout. The same
request's human approvals are context, not a blanket session permission.
Human takeover during an in-flight review revokes the automatic decision.
Defaults remain `human` for bindings that have not opted in.

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

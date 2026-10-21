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
have finished. Native session switches/branches require owner review and a
new explicit binding; OMB never silently follows them. Unsupported dialogs,
protocol mismatches, another detected session writer, or lost connectivity
stop the connection without a raw-input fallback.

Privacy Filter remains an independent setting. NativeConect does not enable
masking when that setting is OFF.

## Mediated approvals and native review

The owner can set `approvalPolicy: "mediator"` on a Pi binding. The native
session keeps its approval gate; OMB asks the binding's tool-free mediator
model to judge eligible low-risk inspection commands and text-note changes
inside its workspace. Only a valid low-importance allow verdict answers the
current native question once. A native safety reason, an important or unknown
command, a sensitive/executable/configuration target, a failed/late review, or
a high-importance verdict retains the owner's Allow/Deny card. Defaults remain
`human` for bindings that have not opted in.

The deterministic checks limit automatic shell approval to supported literal
inspection commands. They are approval checks, not an operating-system sandbox
or a complete proof of a command's effects. Existing PATH, native tool behavior
and filesystem links remain part of the destination's trust boundary. The model
cannot grant session-wide permission or approve a native question already
answered in the human TUI. Review requests use the same authenticated mediator
model as the binding, in a tool-free independent call, bounded to 20 seconds.

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

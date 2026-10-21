# Personal fork: tool privacy and composer keys

`modelDetectionEnabled: false` stops model and supplementary-rule detection,
including Google Chat's otherwise forced feed/body filtering and manual masking.
It closes the local detector without disconnecting Google Chat. Registered literal
replacements and local restoration remain available; unregistered information
passes through. Missing settings retain detection for backward compatibility.

The Personal settings keep scheduled filtering separate from an optional tool
capability. Enabling tool filtering wraps registered MCP/browser/Connected Apps/Data
servers locally. The tool catalog adds `_openmausbot_local_privacy: true` as an
optional argument. The proxy consumes it before calling the upstream tool, then
runs the local OpenAI privacy-filter on the result before returning any text or
structured mirror to the AI. An error or unsupported binary result blocks that
protected call; no raw-result fallback is used. Automatic routine filtering cannot
be disabled by passing false to this option.

When this capability is enabled, registered literal replacements apply to all
wrapped tool results without invoking the model. Ordinary conversation text is
unchanged. Existing opt-in routine/source selections remain supported. Changes to
tool availability take effect on the next connection/turn. No remote transcription
or cloud filter is introduced.

The settings preview is literal-only and runs in the browser without sending its
sample to a model or saving it to browser storage. Multiple exact spellings share
one alias. `restoreAs` chooses the local display/draft spelling; old settings fall
back to the first spelling. The existing Mac-only vault persists this choice with
the same private permissions and scoped restoration. Already-issued aliases remain
stable. Reusing an old alias for a different identity is still rejected.

Restored drafts are editable/copyable local text. They are not sent to the AI,
Google Chat, or other tools, and closing the draft discards it. The user requested
draft preparation only; no automatic restored outgoing action is implemented.

## Composer

Personal builds default to Enter = send/queue, Shift+Enter = newline, and Cmd+Enter
(Ctrl+Enter on other keyboards) = steer a running turn. Settings let each device
swap these bindings; collisions swap rather than duplicate a binding. IME candidate
confirmation never sends. Busy composers offer separate queue and steer buttons.
An explicit bot queue bypasses live steering even if the engine supports it.
Explicit steering refuses when it cannot be delivered, preserving the draft.
Rooms use their existing ordered queue/steer mechanism; a refused room steer keeps
the accepted queue entry and reports the error. Goal mode uses its existing queue.

## Verification

Run isolated synthetic regression tests:

```sh
pnpm exec vitest run server/privacy/privacy.test.ts server/privacy/automation.test.ts server/privacy/tool-batches.test.ts server/privacy/tool-option.test.ts src/lib/privacy-alias-preview.test.ts src/lib/composer-keymap.test.ts src/components/PersonalPrivacySettings.test.ts src/components/PrivacyText.test.ts src/components/Composer.delivery.test.ts src/components/Composer.ime.test.ts src/components/Composer.dictation.test.ts server/routes/bot-messages.test.ts server/steer-e2e.test.ts --maxWorkers=1
pnpm typecheck
pnpm lint
```

A separate local acceptance fixture exercised the actual stdio MCP proxy, service,
and MPS detector with fictional Japanese names, email, phone, and mirrored JSON.
The mock AI boundary received no originals on protected calls. Literal-only calls
invoked the detector zero times. Model failure returned an error without the
original result, and the local option did not reach the upstream tool's arguments.
The first model call, including startup, took 13,104 ms on this Mac.

This feature does not intercept CLI-owned file/browser/network access, MCP servers
configured only inside a CLI, tool/resource catalogs, direct MCP resource/prompt
retrieval, existing history/memory, or every
provider's direct traffic. Calls that omit model filtering use only the registered
literal rules unless selected by routine/thread protection. Detection can miss
personal information. No real Google Chat data or live posting was used to verify
these changes.

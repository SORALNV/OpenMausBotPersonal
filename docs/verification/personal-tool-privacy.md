# Personal fork: registered words and composer keys

OpenAI privacy-filter inference, automatic PII rules, worker setup and strict mode
are removed. Settings expose registered literal replacements only. Unregistered
names, email addresses, phone numbers and secrets pass through unchanged.

Multiple exact spellings share one alias; `restoreAs` chooses the local spelling.
The preview runs in the browser without a model or browser storage. Longer matches
win, replacement does not cascade, and aliases persist with owner-only permissions.
Existing vault entries remain restorable only within their original thread scope.
Restored drafts are local editable/copyable text, never an automatic outgoing action.

Tool-result replacement and selected local routines have separate switches. Normal
chat prompts remain unchanged. Protected tool failures and unsupported opaque
results block instead of returning raw contents. The MCP catalog is unchanged;
the removed `_openmausbot_local_privacy` argument is rejected before upstream calls.
The proxy uses `/api/internal/registered-words`; the old model endpoint returns410.
Startup backs up and removes the legacy model setting without deleting aliases.

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

Use fictional data in isolated homes and loopback-only mock services:

```sh
pnpm exec vitest run server/privacy src/lib/privacy-alias-preview.test.ts src/components/PersonalPrivacySettings.test.ts src/components/PrivacyText.test.ts src/components/PrivacyWorkbench.test.ts server/google-chat.test.ts server/google-chat-diagnostics.test.ts
node scripts/registered-words-acceptance.mjs
pnpm typecheck
pnpm lint
```

The acceptance fixture starts the real server and stdio MCP proxy, a fake tool and
a mock AI. It checks that ordinary chat is unchanged, scheduled prompts and tool
results replace three registered spellings, unregistered email is unchanged,
restoration is scoped, unsupported images are blocked, and corrupt settings stop
AI dispatch. It uses no real AI credentials, Google Chat content or Pi commands.
Evidence is written under `.privacy-dev/evidence/registered-words-acceptance.json`.

This does not intercept CLI-owned file/browser/network access, MCP servers configured
only inside a CLI, catalogs, direct MCP resource/prompt retrieval, existing history
or memory, or every provider's direct traffic. It is literal substitution, not an
automatic personal-information detector. Physical phone and live Google Chat delivery
require separate verification.

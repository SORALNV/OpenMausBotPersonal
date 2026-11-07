# Antigravity NativeConnect delegation

The normal OMB Bot retains its model, persona, memory, conversation and OMB
tools. Its optional `native_connect` tool delegates a self-contained task to
the public `agy` CLI. Ordinary consultation does not start that CLI. The native
harness executes its own tools and owns its history; the Bot reads the result
as external information and answers in its normal conversational style.
NativeConnect is not a model in the Bot model picker.

## Configuration

In Personal Settings → General → **NativeConnect / Antigravityへの委託**, enable
delegation and choose the destination model. Refresh obtains the real `agy
models` list. Changes apply on the next Bot turn. This never changes a Bot's
own model, permissions, or existing NativeOMP/Codex connections.

The owner's private `native-connect.json` contains `enabled`, `model`, and an
absolute `binary` path. The binary is provisioned locally, not set by an agent.
Settings and receipts are owner-only. Credentials remain managed by the native
CLI; this connector neither extracts nor copies them. One native conversation
is retained per OMB Bot/thread, including after restart. No OMB thread is created.

Use a Full access direct conversation with unrestricted native tools. The
connector preserves the CLI's permission policy and never adds
`--dangerously-skip-permissions`. OMB `/allow-all` does not change native CLI
permissions. Disabled, stale-turn, restricted-scope and group calls are refused.

## Qualification

```sh
node --test scripts/native-antigravity.node-test.mjs
node node_modules/vitest/vitest.mjs run server/native-connect.test.ts server/native-antigravity.e2e.test.ts src/components/NativeConnectSettings.test.ts --maxWorkers=1
```

The transport tests use a disposable native peer implementing Google's
[public headless format](https://antigravity.google/docs/cli/headless/). They
check exact prompts, dynamic model IDs, history resume, private state, cross
process exclusion, cancellation, timeouts and uncertain-result replay refusal.
Output is bounded; hidden thinking and raw stderr are not displayed.

The E2E uses `launchVerificationServer` and canonical `send`, `wait`, `messages`
verbs. A synthetic conversational engine invokes the real scoped agents MCP
tool, which reaches the native peer. Assertions cover retained persona/model/
tools, no native work for ordinary chat, short main-Bot final replies, native
progress, native conversation continuity after restart, and no new OMB threads.
It tests wiring, not a real model's routing judgement. No live user conversation
or account participates in these automated tests.

## Limits

- NativeConnect currently delegates text in direct chats. Attachments are not
  forwarded. Interactive native approvals, independently opened human TUI
  simultaneous writes, and arbitrary existing-session selection are unqualified.
- The run tool waits for native completion (up to five minutes); client-side
  MCP timeouts can end that wait earlier. Disconnects or uncertain completion
  are never automatically replayed. Reconcile native history before clearing a
  pending receipt or a crash's stale lock.
- Stop cancels the owned CLI process group. Remote or detached work may require
  separate confirmation. A native SUCCESS envelope alone does not prove every
  native tool ran; permission diagnostics must be interpreted.
- Google's [consumer-plan FAQ](https://antigravity.google/docs/faq) restriction
  on third-party CLI wrappers remains applicable. The owner authorized this
  integration after being informed; NativeConnect does not hide automation or
  change the provider's rules. Billing allocation is not proven by model IDs.

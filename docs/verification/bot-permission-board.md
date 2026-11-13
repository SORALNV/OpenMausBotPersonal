# Bot service and MCP permission board

Settings → **Bot services & MCP permissions** (Japanese: **Botのサービス・MCP権限**)
is an owner/admin-only tab in both simple and advanced Settings. Rows are visible
bots, including their departments; columns are the current account's connected
services, native email when connected, and registered MCP servers. Bot/resource
search and service/MCP filters only change the view, never grants.

## Automated qualification

```sh
pnpm exec vitest run src/lib/bot-permission-board.test.ts src/components/BotPermissionBoard.dom.test.ts src/components/SettingsModal.botPermissions.test.ts server/settings-permissions-matrix.e2e.test.ts
node --experimental-strip-types scripts/verify-bot-permissions.mjs
```

All mutations use disposable fake-engine server data. No live bot, private
account, real service credential or external model is needed. The Electron
smoke mounts the actual Settings modal, production store and board through
Vite; its network allowlist permits only the local preview and fixture server.
It does not load the packaged app or production preload.

The smoke verifies:

- Simple/advanced tab navigation, away and back, through real Settings buttons.
- Initial per-bot cells, globally disabled MCP cells, independent two-bot
  service/MCP changes and successful-save feedback.
- Real `PATCH /api/bots/:id`, fresh HTTP reads and durable fixture `bots.json`.
- Exact-tool grants retained, explicit MCP lists and persistence after reload.
- Bot/resource search, MCP-only category, Japanese translations and 390px layout.
- Horizontal matrix scrolling confined to its region; sticky Bot column and
  headers; no horizontal document overflow or external requests.

It prints an evidence directory containing `receipt.json`, `electron.log`, and
screenshots including `permissions-japanese.png` and `permissions-narrow.png`.
Its temporary profile and fake server are removed afterwards; evidence remains.

The HTTP integration test also runs fake turns and invokes the real internal
connector gate against a loopback stand-in. It proves withheld/excluded/write
operations are denied and an immediate app revocation blocks further calls.
Busy MCP list changes return 409 and preserve the prior durable list. No paid
model or actual mail operation is performed.

## Permission semantics

- Every edit reads a fresh bot snapshot before deriving a minimal permission
  patch. The board waits for a successful server response before displaying a
  changed check. A per-bot synchronous in-flight guard prevents lost compound
  grants from simultaneous cells; other bots can still be edited.
- Services reuse `botAppScope` and `appSwitchPatch`. Existing read-only scopes
  and exact-tool restrictions are retained. An app newly switched on receives
  normal **write** scope; switching a read-only app off and back on also grants
  write, still subject to any retained exact-tool list. Unknown grant formats
  are read-only. A bot with services globally off starts with only the newly
  selected app granted, not every connected app.
- A missing MCP list inherits effective eligible servers. Its first edit
  materializes an explicit selection, retaining existing effective delegation
  grants and excluding another bot's servers. A list does not enable a globally
  disabled server or create a delegation grant. Delegated/global-off/foreign
  server cells are read-only; tool-scope ceilings remain enforced.
- `offFor` is connection health, not permission. Its warning is shown without
  preventing revocation. Busy MCP changes are disabled in the UI and rejected
  by the server. Service revocations can take effect during a turn.
- Inventory failures disable affected edits rather than treating unknown state
  as an empty list. Refresh retries without clearing grants. Native email has
  its own connection status check.
- This board manages the server's **bot-side ceiling**, not credential sharing.
  It does not combine members' private app inventories, bypass private-audience
  rules, or control independent connections installed inside an external CLI.
  Computer, filesystem and model-native tool permissions remain separate.

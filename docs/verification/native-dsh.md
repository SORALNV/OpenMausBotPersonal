# Jetson DeepseekHarness NativeConnect

The `deepseek` NativeConnect destination uses the installed DSH 0.2.0-rc.2 Web
operator protocol. DSH itself is unmodified. One standard Web process owns its
sessions; a human uses that process's ordinary browser UI and OMB submits ordinary
`source.kind=user` prompts with stable request IDs. Luna selects local advice,
OMB management, or native execution and formats a display copy of native output.

The SSH destination must be an RFC1918 IPv4 address. Host-key checking remains
strict, forwarding of agent credentials is disabled, and no Tailscale address is
used. The remote Web service binds only to `127.0.0.1:3082`; it does not expose an
unauthenticated service to the LAN. The connector exchanges the launch URL printed
by its own standard DSH process for the standard authority-bound browser cookie.
It neither reads the browser signing secret nor manufactures a cookie.

`scripts/native-dsh-host.mjs` supervises that standard process, stores its issued
launch URL in a private `launch.json`, and suppresses secret-bearing startup logs.
`scripts/native-dsh-relay.mjs` uses the existing installed `ws` dependency and
passes standard HTTP/WS messages over SSH. Disconnecting OMB closes its guest
connection and leaves the standard Web process running. Do not run two writers
against a session: a session already owned by the previous Web process is rejected
by DSH's normal writer lock. Use the same Web process for the human and OMB.

Run the synthetic transport checks and the existing isolated harness acceptance:

```sh
node --test scripts/native-dsh.node-test.mjs
node scripts/native-omp-acceptance.mjs
node node_modules/vitest/vitest.mjs run server/native-omp-service.test.ts server/native-omp-sessions.test.ts src/components/NativeOmpSettings.test.ts --maxWorkers=1
```

Native queue admission preserves human drafts; steer uses the standard native
steering mode only after OMB mediation. HTTP admission and durable user events are
distinct evidence. Unknown submission outcomes are not replayed. A confirmed
native failed turn is recorded as ended and cannot remain an indeterminate busy
job. Model-private reasoning is not projected into OMB progress.

The human and Bot retain original native text. Tool results/progress are read from
native log events. High-risk approvals use the existing OMB mediation policy;
native approval events are tied to their exact session and cancel when the native
request is settled. Ordinary native question batches are returned through the
standard `$events/result` endpoint. OMB supports one selected option per card;
the native Web UI remains available for richer multi-select interactions.

Owner setup is in Settings → General → NativeConnect → DeepseekHarness の接続先を追加.
That setting does not install software on an arbitrary host. Install and start the
standard Web supervisor on the selected SSH host first, then save the destination
and explicitly create/select its session. Other Bot bindings are retained.

Live qualification must use a disposable OMB home and a dedicated synthetic DSH
session, never artificial prompts in the user's existing conversations. Record
protocol, real model, actual tools, native-human input, and Personal GUI setting
checks separately. A simulated mediator does not establish live Luna accuracy.

## Fixed and free management

Per-thread `session` remains the fixed destination mode. The optional `router` mode
has no manager/seed session: ordinary advice stays in OMB, and the mediator chooses
an existing native session or a reusable purpose name only for actual native work.
A purpose name is normalized and receives a stable creation operation ID. Automatic
creation is bounded to eight native sessions per OMB thread; existing sessions are
not limited to eight. OMB never creates a visible thread merely to route work.

`private/native-omp-modes.json` and `native-omp-routing.json` persist that choice
and its reuse records. Switching to fixed mode clears the router flag but retains
the reuse records. Each OMB thread retains at most one native guest connection,
and switching a destination closes the prior guest without stopping the native
harness. A native writer lock held by another DSH process is respected; the
connector does not steal the lock, fork the conversation, or replay a request.

Use Settings → NativeConnect → 接続方式 to select fixed or free management. The
legacy manager option still binds a dedicated management conversation and is
distinct from unpinned free management. Run `server/native-omp-router.test.ts` for
reuse, restart, no extra OMB threads, fixed-mode isolation and the creation bound.

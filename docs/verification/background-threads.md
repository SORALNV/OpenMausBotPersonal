# Personal: one foreground conversation and bounded background work

The ordinary bot thread list excludes automatic work (`background: true`),
including scheduled execution, delegated jobs, parallel room jobs, bot-opened
jobs and incident work. A person can still create a normal thread explicitly.
A currently running background job is reachable through the chat's other-activity
picker; finished jobs disappear from that picker. Opening the bot again returns
to its main conversation. Stored transcripts remain available through run cards
and existing references; hiding them does not erase history.

The companion projects ordinary bot `tasks` arrays before sending HTTP snapshots
or SSE updates, including replayed events. This also supports released phone
clients that ignore the `background` field. An explicit POST opening one task
can return that task's detail and approval card, but a subsequent list snapshot
again excludes background history. Group task lists and user message content
are unchanged. This projection does not delete records or mark messages read.

Only one background execution per bot is admitted at a time. Other routines wait
before allocating their execution thread, and other delegated jobs stay queued.
Approval waits retain the slot, without automatically approving or cancelling
them. The existing total per-bot concurrency limit still applies to foreground
work. This is a limit on active execution, not a deletion limit for audit history.
The existing stall watchdog remains responsible for unresponsive turns.

After a background turn settles, Claude and ACP release only its idle transport;
a running turn is never closed by that operation. History and resume cursors are
retained. Local background transports also use a 30-second idle fallback and
cannot opt into cache keep-warm. Shared Codex app-server processes and the M1/Pi
NativeConnect sessions are not shut down by this cleanup.

On startup, legacy work threads and routine-created execution records are
classified without removing messages. A routine is matched to a newly allocated
record by its recorded creation and start times; a previously existing human
conversation and an explicitly promoted thread are not reclassified. If a local
routine's results destination disappeared, its result and pending card use the
existing main conversation. Cloud ownership separation is preserved.

## Checks

```sh
pnpm exec vitest run server/background-threads.test.ts server/background-threads.e2e.test.ts \
  server/main-thread.test.ts server/store.test.ts server/routine-results.e2e.test.ts \
  server/automation-reports.test.ts server/automation-reports.e2e.test.ts \
  src/components/BotThreads.test.ts src/state/thread-navigation.background.test.ts
pnpm exec vitest run companion/test/wire.test.ts companion/test/proxy-response.test.ts
pnpm exec vitest run server/drivers/claude.test.ts -t 'releases only an idle transport'
```

The end-to-end check launches the repository's fake Claude engine in an isolated
home and explicit loopback URL. It holds one background job, queues a second,
accepts human input in the main chat, releases the jobs, checks that the first
CLI PID exits, checks the next transport's idle-close record, verifies both
reports in the main chat, and checks the real companion's authenticated list
and explicit background transcript access. It records the resulting bot/run
state. It never
sends a prompt to a user's real bot or changes real conversations.

The renderer checks cover the actual sidebar components with accumulated
background records and the main-chat navigation. These checks do not constitute
a live desktop or phone UI acceptance test, nor a qualification of every ACP
provider's own process termination behavior.

# Bot-opened thread cleanup

Personal checks every ten minutes. By default it archives Bot-opened and automatic
threads after 24 hours without meaningful message activity or a recent human
read. A new server waits for the first interval, allowing the restored UI to
record which conversation the person has open. Housekeeping messages do not keep
a thread alive when a meaningful activity stamp exists.

Human-created/promoted threads, pinned threads, active/queued/delegated work,
approval/question cards and explicitly bound NativeConnect/Codex threads are
protected. Archiving clears obsolete unread notifications. It retains transcript
rows, messages, provider resume cursors, links and remote harness sessions. A
normal unarchive also records human presence, preventing immediate re-archiving.
Up to 100 records are archived in one pass; remaining candidates wait for the
next pass. No model is invoked by cleanup.

Settings → General → Botスレッドの自動整理 supports enable/disable, 1–720 idle hours,
and an owner-only manual sweep. Policy changes apply to the next sweep without
restarting. The owner-only routes are `/api/bot-thread-cleanup` (GET/PUT) and
`/api/bot-thread-cleanup/run` (POST); clients cannot supply timestamps or arbitrary
thread IDs. Private policy storage is owner-only, bounded and atomically replaced.

```sh
node node_modules/vitest/vitest.mjs run server/bot-thread-cleanup.test.ts
node scripts/bot-thread-cleanup-acceptance.mjs
```

The acceptance script seeds old synthetic threads before starting the full server
in a disposable home. Through the authenticated fixture HTTP surface it checks
automatic eligibility, pending-card protection, human/pin protection, preserved
transcripts, normal restore, and hot policy changes. It never sends a message to a
real Bot or modifies real conversations. The renderer setting and packaged
Personal startup need separate GUI acceptance.

# Offline Host History Migration Design

**Status:** Approved in conversation on 2026-08-17.

## Context

The companion repository moved from
`C:\Users\asten\AppData\LocalLow\ZAUM Studio\Disco Elysium\companion`
to `C:\Git\disco-elysium-companion`. The repository, ignored runtime state,
Claude project directory, and stable Claude and Codex configuration keys are at
the new location. A fresh-context review found two remaining path-keyed history
stores:

- `C:\Users\asten\.claude\history.jsonl` has Claude prompt-history records whose
  `project` value still names the old repository root.
- `C:\Users\asten\.codex\state_5.sqlite` has Codex `threads.cwd` rows whose value
  still names the old root with the Windows extended-path prefix.

Both stores are live host data. They must be migrated only while their owning
applications are closed. The currently running Codex session cannot safely
migrate its own SQLite database.

## Objective

Provide one temporary, self-contained PowerShell helper that previews the exact
migration without writing by default and performs it only with an explicit
`-Apply` switch. The applied migration preserves unrelated data, creates verified
backups before the first host-store write, tolerates a restart after either store
has already migrated, removes the retired empty repository root, and leaves a
machine-readable receipt for the next Codex session.

## Scope

The helper owns these changes:

1. Replace exact Claude `project` values equal to
   `C:\Users\asten\AppData\LocalLow\ZAUM Studio\Disco Elysium\companion` with
   `C:\Git\disco-elysium-companion`.
2. Replace exact Codex `threads.cwd` values equal to
   `\\?\C:\Users\asten\AppData\LocalLow\ZAUM Studio\Disco Elysium\companion`
   with `\\?\C:\Git\disco-elysium-companion`.
3. Remove the old repository directory non-recursively after confirming it is
   empty.
4. Write an execution receipt under the new repository's `.tmp` directory.
5. Correct the tracked quick-win history so it records the real copy, hash
   verification, authority cutover, source clearing, and temporary locked-shell
   sequence.

The helper does not change session JSONL contents under either host's session
archive, rewrite rollout paths, alter Git state, migrate application settings
already moved, touch game state, or read or write any file under SaveGames.

## Files

- `.tmp/Finish-RepositoryRelocation.ps1`: preview and apply entry point plus its
  private migration functions.
- `.tmp/Test-FinishRepositoryRelocation.ps1`: staged fixture tests.
- `.tmp/relocation-history-backups/<UTC timestamp>/`: immutable backup set for
  one apply attempt that will write a host store.
- `.tmp/relocation-history-migration-result.json`: latest successful completion
  receipt.
- `.claude/QUICK_WINS_HISTORY.md`: corrected durable archaeology.

The helper and tests are ignored temporary operational artifacts. The receipt and
backups remain ignored and local. The tracked history correction receives its own
fixup commit against the relocation commit.

## Command interface

Running the helper without arguments is preview mode. Preview parses and counts
both stores, reports process blockers and old-root state, and makes no filesystem
or database changes.

Running with `-Apply` repeats every preview validation and performs the migration.
Apply never treats an earlier preview as fresh evidence. The helper derives its
display name once from its script path and uses that name for every diagnostic.

The human workflow is:

1. Run preview while the current session is open and inspect the intended counts.
2. Close Claude and every Codex process.
3. Run the same script from ordinary PowerShell 7 with `-Apply`.
4. Reopen Codex at `C:\Git\disco-elysium-companion`.
5. Ask Codex to verify `.tmp/relocation-history-migration-result.json` and the
   current host-store counts.

## Preview and preflight

Preview validates all paths and parses every Claude JSONL record. It opens the
Codex database read-only, verifies the `threads.cwd` surface exists, and counts
exact old and new values in both stores. It reports but does not reject running
host processes because preview is intentionally usable from the current session.

Apply fails closed before creating backups when any of these conditions holds:

- A process whose name identifies Claude, Codex, or the Codex code-mode host is
  running.
- The target repository is missing or resolves outside
  `C:\Git\disco-elysium-companion`.
- Either host store is missing, malformed, or uses an unexpected schema.
- The old repository root exists and contains any entry.
- A required SQLite executable cannot be resolved.
- An existing receipt or backup path would be overwritten.

Apply repeats the process guard immediately before the first host-store write.
If a host starts after that guard, normal file or SQLite locking causes the
operation to fail. The helper never bypasses a live-store lock.

## Backup lifecycle

An apply attempt that will change at least one host store creates one new backup
directory named with a collision-resistant UTC timestamp. It copies the Claude
history file and the Codex main database plus any present `-wal` and `-shm`
companions before opening a write transaction. Each copied file receives a
SHA-256 entry in a manifest. The helper re-hashes every backup and requires an
exact match before continuing.

Backup directories are immutable after verification. Failed and successful
attempts retain their backups indefinitely until the user removes them. The
helper never chooses a backup automatically and never restores over current host
data. Manual recovery requires both applications closed, an explicit backup
choice, and replacement of the complete backed-up file set.

Preview and an already-complete apply create no backup because they perform no
host-store write. A partial prior migration may therefore create a new backup
containing the remaining current state on its next apply; earlier backups remain
available.

## Claude JSONL migration

The helper reads the file as UTF-8, preserves record order, and parses every
non-empty line before writing. Only records whose parsed `project` value is an
ordinal exact match for the old root change. Nonmatching lines remain byte-for-byte
unchanged. A changed record preserves every property other than `project` with the
same JSON value and keeps its position in the file.

The candidate output is written beside the source file, flushed, reparsed in
full, and compared against the original records after normalizing only the
approved project substitution. The helper then atomically replaces the source.
If candidate construction, validation, flushing, or replacement fails, the
original remains authoritative and the helper stops before opening a Codex write
transaction.

## Codex SQLite migration

The helper opens `state_5.sqlite` through the installed SQLite command-line tool
only after the offline and backup gates pass. One immediate transaction counts
the exact old and new values, updates only exact old values, verifies the expected
post-update counts, and commits. The expected new count is the pre-update new
count plus the number of migrated old rows. Index maintenance is left to SQLite.

After commit, a fresh read-only connection requires `PRAGMA integrity_check` to
return the literal `ok`, zero old rows, and the expected new total. A transaction
or post-commit validation failure is terminal for that run. The helper does not
automatically restore a backup because doing so could overwrite data created by
an external process after the guard; it reports the backup path and the exact
partial state for explicit recovery.

## Idempotency and durable transition states

The two host migrations are independently idempotent. Each run derives work from
current exact-value counts rather than assuming both stores share one phase.

The expected durable states are:

1. **No backup written:** both stores and the old root are unchanged. Re-run
   preview or apply after resolving the preflight error.
2. **Verified backup written, no host store changed:** re-run apply. A new attempt
   may create another immutable backup; the prior backup remains valid evidence.
3. **Claude migrated, Codex unchanged:** re-run apply. Claude has zero old values
   and is a no-op; Codex performs its remaining exact update.
4. **Codex migrated, Claude unchanged:** re-run apply. Codex has zero old values
   and is a no-op; Claude performs its remaining exact rewrite.
5. **Both stores migrated, old root still present and empty:** re-run apply. Both
   stores are no-ops and cleanup retries the non-recursive removal.
6. **Both stores migrated and old root absent, receipt missing:** re-run apply.
   Validation succeeds and a new receipt is written without a host-store backup.
7. **Receipt written:** re-run preview to validate current counts. Re-running
   apply is a validated no-op that may refresh the receipt but does not rewrite
   either host store.

If the old root is non-empty in any state, apply stops before changing a host
store or deleting anything. The user must inspect the unexpected entries.

## Cleanup and receipt lifecycle

Old-root cleanup uses a literal, fully resolved path and non-recursive removal.
The helper performs it only after both history stores pass their post-migration
checks. An absent root is already complete. An empty but locked root produces a
nonzero apply result with the completed store state reported; a later apply can
retry cleanup. A non-empty root is never removed.

The receipt is created only after store validation and successful or already
complete old-root cleanup. It records schema version, status, UTC completion
time, exact old and new paths, per-store pre-counts, migrated counts, post-counts,
SQLite integrity result, backup directory or null, backup hashes, and cleanup
result. Writing a new successful receipt atomically replaces the prior receipt.

The receipt is execution evidence, not a cache of current host state. It becomes
stale as soon as either host writes new history. The reopened Codex session uses
it to identify the completed operation and backup, then queries current exact
counts before declaring success. A missing, malformed, wrong-path, or non-complete
receipt never permits an inferred success; current stores must be inspected.

## Diagnostics and exit behavior

All failures are typed PowerShell exceptions inside helper functions. The script
entry point catches them, writes one concise error prefixed with the derived
script name, and exits nonzero. Preview and apply print one JSON result object on
success so the user and reopened Codex session can verify literal counts.

No diagnostic includes Claude prompt text, pasted content, session content, or
other history payload. Reports include paths, counts, hashes, process names, and
structural validation results only.

## Testing

The fixture suite creates all data under the repository `.tmp` root and never
opens the real host stores for write. It constructs real JSONL files and real
SQLite databases with the production `threads.cwd` column and exercises the
helper functions directly.

Required tests cover:

- Preview reports old and new counts while all fixture bytes remain unchanged.
- Apply changes only exact old Claude project values and preserves unrelated
  records, property values, and record order.
- Apply updates only exact old Codex cwd values and passes integrity checking.
- Backup files and manifest hashes match their source bytes from before mutation.
- A second apply is idempotent and does not rewrite either host store.
- Claude-already-migrated and Codex-already-migrated fixtures both resume to the
  complete state.
- A non-empty old root fails before backup or host mutation.
- Process-name classification rejects Claude, Codex, and the code-mode host while
  ignoring unrelated processes.
- A malformed JSONL record, unexpected SQLite schema, missing SQLite tool, or
  backup hash mismatch fails closed.
- Receipt fields, null backup on an already-complete run, and atomic receipt
  replacement match the contract.

Each behavior follows a red, green, refactor cycle. The real helper receives only
a preview run from Codex; the user runs the applied mutation after closing both
hosts.

## Completion criteria

The design is complete when fixture tests pass, preview reports the independently
verified live counts without modifying either store, the tracked archaeology is
corrected, and the helper prints the exact offline apply command. Operational
completion occurs only after the offline apply receipt exists, both stores contain
zero exact old-path values, SQLite integrity is `ok`, the old root is absent, and
a reopened Codex session confirms the repository root and SessionStart guidance.

# TODO

This app's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and this repo's `REPO_SCOPE.md` entry for that). Just what's not built yet.

## Features

- Windows Task Scheduler integration so scheduled mappings can run even
  when the app itself isn't open. Schedules and watchers only fire while the
  app process is running; "catch up" covers gaps but not a closed app that
  never gets reopened.
- Watch mode that processes only the *new* files instead of re-running the
  whole job (needs the engine to accept an explicit file set, and a story for
  how later steps in a chain learn which files an earlier step produced).
- Job preview that simulates later steps against the earlier steps' output
  (today each step is previewed against the folders as they are now).
- Undo/restore from the Recycle Bin on macOS and Linux (today it is Windows
  only; Electron can trash but not restore).
- Undo for an unzip that merged into an existing folder (needs per-file
  extraction records so the user's own files can be told apart).

## Reliability and performance

- Journal each file's outcome as it happens, not when its step finishes, so a
  crash *mid-step* still leaves a history row (and undo) for the files already
  handled. Today a crash loses at most the one in-flight step's record.
- The database is still written whole on every save (sql.js is in-memory). A
  native SQLite binding (e.g. better-sqlite3) would make saves incremental and
  remove the need to hold history in memory.
- Moves/copies/zips run one file at a time to keep conflict resolution
  deterministic; throughput could be raised by parallelising the safe cases.
- Run `npm run smoke` in CI (needs a display; currently local only).

## Fixes

-

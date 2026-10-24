# FileShuttle

<img src="assets/logo.png" alt="FileShuttle logo" width="160" />

A desktop app that moves files between folders on a schedule, or on demand.
Define **mappings** (a source folder, an action, optional filters, and what to
do on a name clash), group them into **jobs** that run mappings in order, and
let a job run manually, on an interval, daily, or the moment a file lands in a
watched folder. It runs in the system tray so schedules keep firing in the
background, with desktop notifications when a scheduled run finishes.

This repo follows [gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards) —
theming, release/CI, self-update, licensing, and database location all
come from there rather than being reinvented locally.

## Features

- **Mappings** — any number of source/destination folder pairs, each
  independently configured and reusable across jobs.
- **Jobs** — an ordered list of mappings with one schedule. Steps run in
  order and are recorded individually in History.
- **Actions** — move, copy, delete (Recycle Bin), zip, or unzip.
  Zip compresses each file or folder found directly in the source folder
  into its own `.zip` in the destination, leaving originals in place.
  Unzip extracts matching `.zip` files into a same-named subfolder of the
  destination, then sends the original zip to the Recycle Bin.
- **Filters** — 0 to N rules per mapping (extension, wildcard/regex
  filename, size in bytes, modified/created date). Rules are grouped: a file
  must satisfy every group (AND), and inside a group any one rule is enough
  (OR), so `(zip OR bak) AND larger than 1 MB` is one mapping. Filters are
  validated when you save, so a bad regex or a size like `5MB` is caught
  immediately.
- **Folders** — type or paste a source/destination path (Explorer's quoted
  "Copy as path" works) and it is checked as you go; Browse opens at the folder
  already entered.
- **Keep newest N** — leave the newest N matching files in place and act on the
  rest (handy for pruning a backup folder). Optionally count each file
  extension separately, e.g. keep the 3 newest `.zip` and the 3 newest `.bak`.
- **Conflict handling** — overwrite, skip, or auto-rename on a name clash.
- **Preview** — see exactly which files a mapping or job would touch, with
  total size, files that would be replaced, and per-file detail, without
  changing anything. A preview runs the same code as a real run.
- **Scheduling** — manual only, every N minutes, daily at one or more set times, or watch
  folders for new files. Watching uses OS filesystem notifications rather than
  polling, so it has no meaningful ongoing cost. Optionally **catch up**: if the
  app wasn't running (or the PC was asleep) when a job was due, it runs once on
  start-up or wake.
- **Live progress and Cancel** — long runs show what they're doing (scanning,
  *N of M files*, which step) and can be cancelled; completed work is kept and
  recorded.
- **Run history and Undo** — per-run counts and per-file detail for every run,
  and Undo for moves, copies, zips, unzips and deletes (see
  [Safety](#safety-and-undo)).
- **Background/tray mode** — closing the window keeps FileShuttle running
  in the system tray so schedules keep firing; optional start-at-login
  toggle in Settings.
- **Theming** — pick any [VisualAssault](https://github.com/gerp93/VisualAssault)
  color theme.

## Safety and undo

FileShuttle moves and deletes real files, so it is conservative by default:

- **Nothing is permanently deleted.** Delete and the zip that Unzip consumes go
  to the Recycle Bin.
- **Overwrite is recoverable.** When a mapping overwrites existing files, the
  replaced file is sent to the Recycle Bin first. If the Recycle Bin can't take
  it (network shares don't have one), that file is left alone and reported. A
  Settings toggle turns the backup off for people who overwrite on network
  drives.
- **Preview before you trust it.** Running a never-run job that deletes or
  overwrites offers a preview first.
- **Unsafe mappings are refused.** A destination that is the source folder, or
  inside it while subfolders are included (always, for zip), would make a
  mapping eat its own output; it is rejected when saved and again at run time.
- **Unzip is bounded.** Archives with too many entries or too much data (a "zip
  bomb") and archives containing paths that would escape the destination are not
  extracted. The limits are configurable in Settings (default 100,000 entries /
  20 GB).
- **Crash-safe database.** The database is written to a temp file and renamed
  into place, with a rolling `.bak`; an unreadable database is quarantined and
  restored from the backup automatically.
- **One run at a time.** A job can't run twice concurrently, and runs execute
  one after another, so two runs never race over the same files.

### What Undo does

| Action | Undo |
| --- | --- |
| Move | Moves the files back (only into a free spot; nothing is overwritten) |
| Copy | Sends the copies to the Recycle Bin |
| Zip | Sends the created archives to the Recycle Bin |
| Unzip | Restores the original `.zip` from the Recycle Bin, then removes the extracted folder — but only if the zip came back, and never for a folder the unzip merged into |
| Delete | Restores the files from the Recycle Bin |
| Overwrite | Also brings back the files the run replaced |

Restoring from the Recycle Bin is **Windows only** (Electron can send items to
the bin but not restore them, so FileShuttle uses the Windows Shell), and only
works while the items are still in the bin. The History dialog lists exactly
what Undo will do before you confirm.

### Things to know

- A **watch** trigger runs the *whole job* (every mapping, in order), not just
  the new file. Folders a job writes into are never watched, so a chained job
  can't re-trigger itself.
- A job **preview** shows each step against the folders as they are right now,
  so a step that works on files an earlier step produces will look emptier than
  it will on a real run.
- Schedules and watchers only fire **while FileShuttle is running** (use
  start-at-login and the tray). Catch-up covers the gaps. Windows Task
  Scheduler integration is on the [backlog](TODO.md).

## Running from source

```bash
npm install
npm run generate-icons   # first time, or after changing assets/logo.png
npm run dev
```

## Testing

```bash
npm test            # unit + integration tests (Vitest)
npm run typecheck   # main process and renderer
npm run smoke       # boots the real Electron main process against a throwaway data folder
```

The tests exercise the engine against real temporary folders, the database layer
against a real sql.js database, the file watcher against real filesystem events,
and (on Windows, outside CI) the Recycle Bin restore against the real bin using
only files the tests create. CI runs the typechecks and `npm test` on every PR.

## Building

```bash
npm run build
npm run package
```

## Project layout

- `src/main/` — Electron main process
  - `engine/` — the file engine: `mover.ts` (run), `undo.ts`, `zipStream.ts`
    (streaming zip), `recycleBin.ts` (restore), `filters.ts`
  - `database/` — sql.js, schema/migrations, crash-safe file writes
  - `services/` — running jobs, previews, retention, start-at-login
  - `scheduler/` — interval/daily scheduler and the folder watcher
- `src/main/preload.ts` — typed bridge to the renderer
- `src/renderer/` — React UI (Jobs, Mappings, Editor, History, Settings)
- `src/shared/` — types and pure logic shared by both sides: validation, path
  safety, schedule maths, undo planning

See [TODO.md](TODO.md) for the current backlog.

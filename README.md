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
  filename, size in bytes, modified/created date, download source). Rules are grouped: a file
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
- **Assistant** — a chat panel (the robot button, bottom of the left rail) that
  sets up mappings and jobs from a plain-language description and asks for
  whatever you left out. See [Assistant](#assistant).
- **Theming** — pick any [VisualAssault](https://github.com/gerp93/VisualAssault)
  color theme.

## Assistant

The chat panel slides out from the right on every page. Describe what you want
("move PDFs older than 30 days from Downloads to D:\Archive every night") and it
works out the mapping and job, checks the folders, previews what it would do,
and asks before saving anything.

It runs on the Claude runtime bundled with the app and signs in with your own
Claude account (the panel walks you through it; FileShuttle never sees your
password).

What it can do:

- read your mappings, jobs and run history, and review them for risky settings;
- list the names, sizes and modified dates of the files in a folder (never what
  is inside them);
- preview a mapping or job — a dry run that changes nothing;
- save mappings and jobs, once you approve each one on an approval card.

What it can't do, enforced in code (`src/main/agent/`) rather than by its
instructions: run a job, undo a run, delete a mapping or job, switch a job on, or
touch any file. **Every job it saves is switched off**; open the Jobs page,
review it (Preview shows what it would do), and turn it on yourself. It is also
given none of Claude's built-in tools and none of your other Claude connectors.

File and folder *names* it looks at are sent to Claude to answer you; file
contents never are.

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

- The **Download source** filter sorts browser downloads by the website they came
  from. It reads the origin Windows browsers record on every downloaded file (the
  `Zone.Identifier` stream), and checks both the page you started the download on
  and the URL the file was fetched from, so `github.com` catches files served from
  its CDN too. Enter a domain (`github.com`, which also covers its subdomains) or
  a domain with a path (`github.com/owner/repo`). Files with no recorded origin
  (made by another program, copied off an NTFS drive, extracted from a zip) never
  match and are simply left alone, as are a browser's unfinished `.crdownload` /
  `.part` files. Windows only. To sort a Downloads folder, make one move mapping
  per website, put them in a watch job in the order you want them to win, and give
  each a different destination: a moved file is gone, so the first matching
  mapping claims it.
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
  - `agent/` — the in-app assistant: `tools.ts` (the only things it can do),
    `actions.ts` (what saving is allowed to change), `session.ts` (approvals),
    `prompt.ts`
- `src/main/preload.ts` — typed bridge to the renderer
- `src/renderer/` — React UI (Jobs, Mappings, Editor, History, Settings)
- `src/shared/` — types and pure logic shared by both sides: validation, path
  safety, schedule maths, undo planning

See [TODO.md](TODO.md) for the current backlog.

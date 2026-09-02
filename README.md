# FileShuttle

<img src="assets/logo.png" alt="FileShuttle logo" width="160" />

A desktop app that moves files between folders on a schedule, or on demand.
Configure any number of source → destination mappings, each with its own
optional file filters (extension, name pattern, size, modified/created
date — matched as AND or OR), conflict handling, and schedule (manual,
every N minutes, or daily at a set time). Runs in the system tray so
scheduled mappings keep firing in the background, with desktop
notifications when a scheduled run finishes.

This repo follows [gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards) —
theming, release/CI, self-update, licensing, and database location all
come from there rather than being reinvented locally.

## Features

- **Mappings** — any number of source/destination folder pairs, each
  independently configured.
- **Actions** — move, copy, delete (Recycle Bin), zip, or unzip.
  Zip compresses each file or folder found directly in the source folder
  into its own `.zip` in the destination, leaving originals in place.
  Unzip extracts matching `.zip` files into a same-named subfolder of the
  destination, then sends the original zip to the Recycle Bin.
- **Filters** — 0 to N rules per mapping (extension, wildcard/regex
  filename, size, modified/created date), combined as either AND
  ("match ALL filters") or OR ("match ANY filter").
- **Conflict handling** — overwrite, skip, or auto-rename on a filename
  collision at the destination.
- **Scheduling** — manual only, every N minutes, daily at a specific
  time, or watch a folder for new files, all running in-app (no OS task
  scheduler required). Watch mode reacts to OS filesystem notifications
  (inotify/FSEvents/ReadDirectoryChangesW) rather than polling, so it has
  no meaningful ongoing performance cost — handy for auto-unzipping
  incoming files the moment they land.
- **Run history** — per-run counts and per-file detail (moved/skipped/
  errored) for every mapping.
- **Background/tray mode** — closing the window keeps FileShuttle running
  in the system tray so schedules keep firing; optional start-at-login
  toggle in Settings.
- **Desktop notifications** when a scheduled run completes.
- **Theming** — pick any [VisualAssault](https://github.com/gerp93/VisualAssault)
  color theme.

## Running from source

```bash
npm install
npm run generate-icons   # first time, or after changing assets/logo.png
npm run dev
```

## Building

```bash
npm run build
npm run package
```

## Project layout

- `src/main/` — Electron main process: SQLite, file engine, scheduler, tray, IPC
- `src/preload/` — (in `src/main/preload.ts`) typed bridge to the renderer
- `src/renderer/` — React UI (Mappings, Editor, History, Settings)
- `src/shared/types/` — shared TypeScript types for IPC

See [TODO.md](TODO.md) for the current backlog.

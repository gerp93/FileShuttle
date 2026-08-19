<img src="assets/logo.png" alt="FileShuttle logo" width="160" />

# FileShuttle

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
- **Filters** — 0 to N rules per mapping (extension, wildcard/regex
  filename, size, modified/created date), combined as either AND
  ("match ALL filters") or OR ("match ANY filter").
- **Conflict handling** — overwrite, skip, or auto-rename on a filename
  collision at the destination.
- **Scheduling** — manual only, every N minutes, or daily at a specific
  time, all running in-app (no OS task scheduler required).
- **Run history** — per-run counts and per-file detail (moved/skipped/
  errored) for every mapping.
- **Background/tray mode** — closing the window keeps FileShuttle running
  in the system tray so schedules keep firing; optional "start at Windows
  login" toggle in Settings.
- **Desktop notifications** when a scheduled run completes.
- **Theming** — pick any [VisualAssault](https://github.com/gerp93/VisualAssault)
  color theme; the in-app logo recolors itself to match.

## Running from source

```
pip install -r requirements.txt
python main.py
```

## Project layout

- `fileshuttle/engine/` — the filesystem move/filter logic (pure Python,
  no UI or database dependency).
- `fileshuttle/db/` — SQLite schema and CRUD for mappings/filters/history.
- `fileshuttle/services/` — glue between the database and the engine, plus
  the Windows start-at-login toggle.
- `fileshuttle/scheduler/` — the in-process APScheduler wrapper.
- `fileshuttle/ui/` — the Flet desktop UI, theming, self-update, and tray.

See [TODO.md](TODO.md) for the current backlog.

# TODO

This app's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and this repo's `REPO_SCOPE.md` entry for that). Just what's not built yet.

## Features

- Windows Task Scheduler integration so scheduled mappings can run even
  when the app itself isn't open (v1 scheduling only fires while the app
  process is running)
- Per-mapping run progress indicator (live file count) during Run Now
- Dry-run / preview mode — show which files would move without moving them
- CI test workflow (`ci.yml`) running `tests/` on push/PR — not yet added
  since no Python CI template exists in KVG_Standards yet and KVGenius
  (the org's other Flet app) doesn't have one either

## Fixes

-

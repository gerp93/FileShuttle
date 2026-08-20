# Version bump

Auto Release (`.github/workflows/auto-release.yml`) always does at least a
patch bump on every push to `main` — it doesn't care what changed. So to
force a release with no real code change (e.g. to pick up an updated
KVG_Standards reusable workflow), edit this file instead of pushing an
empty commit. Add a one-line entry below with the date and why, so the
commit shows a real diff instead of nothing.

- 2026-08-19 — created this file
- 2026-08-19 — force a rebuild to pick up gerp93/KVG_Standards#11 (release-flet.yml
  now passes `--yes --no-rich-output` to `flet build`; the v0.0.1 release built
  before that fix landed and shipped with no platform binaries attached)

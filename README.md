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
- **Phone access** — open the whole UI from your phone over Tailscale (off by
  default). See [Open it from your phone](#open-it-from-your-phone).
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

## Open it from your phone

FileShuttle can serve its full UI to your phone's browser over your private
[Tailscale](https://tailscale.com) network. It is **off by default**.

1. On the PC, open **Settings → Remote access**, set a password (8+ characters)
   and switch on **Allow access from my phone**. FileShuttle then listens on
   `127.0.0.1:8765` only (the port is configurable); nothing else on the network
   can reach it directly.
2. In a terminal on the PC, publish that port to your tailnet:

   ```
   tailscale serve --bg 8765
   ```

   **Never use `tailscale funnel`** — that would put the app on the public
   internet. `tailscale serve` keeps it inside your tailnet and adds the
   `Tailscale-User-Login` header the optional allow list below relies on.
3. On the phone (signed in to the same tailnet), open the address
   `tailscale serve` prints (`https://<pc-name>.<tailnet>.ts.net`) and sign in
   with the password.

What you get: jobs, mappings, history, undo and settings, with live progress. Folders are
picked with an in-page folder browser (it lists the PC's folders). Desktop-only things —
the assistant, database location, start with Windows, update check and "open in
Explorer" — are not offered from the phone, and the Remote access settings
themselves can only be changed on the PC.

How it is protected:

- Listens on `127.0.0.1` only; every `/api` route needs a signed-in session
  (random id in an `HttpOnly; Secure; SameSite=Strict` cookie, 30 days idle expiry,
  all sessions dropped when the password changes).
- The password is stored only as a salted scrypt hash. Five wrong attempts in 15
  minutes locks sign-in for that client for a while.
- Optional **Allowed Tailscale logins** (e.g. `someone@gmail.com`): when set, anyone
  else is refused before the password is even asked for. This trusts the
  `Tailscale-User-Login` header, which is only trustworthy because the server accepts
  connections from this PC alone, behind `tailscale serve`.
- State-changing requests must come from the same origin and carry a custom header
  (CSRF), the page is served with a strict Content-Security-Policy, and only an
  explicit list of operations can be called (see `src/main/api/channels.ts`).

## Headless server

The hub and worker also run **without Electron**, as one Node program, for a
Linux box that is always on. It serves the same web UI and API as "Open it from
your phone", with password sign-in, and is packaged as a `.deb`
(`fileshuttle-server`) by KVG_Standards' `release-node-deb.yml`.

```bash
fileshuttle-server --version
fileshuttle-server set-password   # asks twice (hidden); or pipe the password on stdin
fileshuttle-server all            # hub + a worker in this process (what the service runs)
fileshuttle-server hub            # hub only
fileshuttle-server worker         # not available yet (phase 5): exits with status 2
```

- **Loopback only.** It listens on `127.0.0.1:8765` and refuses to start on any
  other address (`FILESHUTTLE_SERVER_HOST`) unless you also set
  `FILESHUTTLE_SERVER_ALLOW_NON_LOOPBACK=1`, which is not needed and not
  recommended. It can move and delete files, so it is never exposed directly.
- **Reach it with `tailscale serve`, never Funnel:**
  `sudo tailscale serve --bg 8765` shares it with your tailnet only.
  `tailscale funnel` would publish it to the whole internet; don't.
- **Settings** are in `/etc/fileshuttle-server/server.env` (all commented
  defaults, no secrets): data folder (`/var/lib/fileshuttle-server`), port, host,
  web folder, trash folder. The password is stored hashed in the database.
- **First start.** The package enables the service but does not start it. Set the
  password (`sudo -u fileshuttle-server fileshuttle-server set-password`), then
  `sudo systemctl start fileshuttle-server`.
- **Which folders jobs can touch.** The unit runs as the unprivileged user
  `fileshuttle-server` with `ProtectSystem=strict` and `ProtectHome=read-only`, so
  it can read most things but write only to its data folder. A job that changes
  files elsewhere, including anywhere under `/home`, fails until you add the
  folders with a drop-in (`sudo systemctl edit fileshuttle-server`):

  ```ini
  [Service]
  ReadWritePaths=/srv/inbox /mnt/data
  ```

  The user also needs normal file permissions there. Deleted files go to a
  freedesktop trash (default `<data dir>/Trash`; folders on another drive use
  that drive's `.Trash-<uid>`); if a file can't be trashed it is left in place and
  the file fails, never deleted outright.
- Removing the package keeps the data; purging deletes the database and settings
  (and the user), but not files still in the trash.

Build it with `npm run build:server` (one file, `dist/server/fileshuttle-server.cjs`,
no `electron` in its imports; a test enforces that).

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
- **Crash-safe database.** The database is SQLite (`node:sqlite`) in WAL mode:
  every change is written straight to disk, and multi-step writes are
  transactions. The first launch of a version using this driver keeps a copy of
  the existing file as `fileshuttle.db.pre-native-sqlite` beside it (never
  deleted by the app). An unreadable database is quarantined and, if an older
  `.bak` exists, restored from it.
- **Hub and worker, in one process.** Inside the app, a *hub* (database, window,
  phone page) talks to a *worker* (scheduler, folder watchers, file mover) with
  JSON messages (`src/shared/workerProtocol.ts`) over an in-process link; nothing
  looks different from outside. Every mapping, job and run belongs to a worker
  (the `local` one, named after this computer), each run has a `run_uid` so a
  report delivered twice is stored once, and a worker's `schedule_version` goes
  up whenever its schedule changes. The first launch of this version keeps a copy
  of the database as `fileshuttle.db.pre-workers` (never overwritten or deleted by
  the app).
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

Restoring is supported on **Windows** (the Recycle Bin, through the Windows Shell)
and **Linux** (the freedesktop.org trash: `files/` and `info/*.trashinfo`, so the
desktop's own "Restore" works too). It only works while the items are still in
the trash, and a file is never overwritten when it comes back. The History dialog
lists exactly what Undo will do before you confirm. macOS is not supported yet.

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
against a real SQLite (`node:sqlite`) database, the file watcher against real filesystem events,
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
    (streaming zip), `recycleBin.ts` (restore), `freedesktopTrash.ts` (Linux trash and restore), `filters.ts`
  - `database/` — `node:sqlite` (named only in `sqlite.ts`), schema/migrations,
    file copies
  - `services/` — previews, retention, start-at-login
  - `hub/` — the hub: worker registry, schedule sync, command dispatch, run history writes
  - `worker/` — the worker: run executor, runtime, and the in-process transport
  - `settings/` — app settings split into hub settings and run settings
  - `scheduler/` — interval/daily scheduler and the folder watcher (worker side)
  - `agent/` — the in-app assistant: `tools.ts` (the only things it can do),
    `actions.ts` (what saving is allowed to change), `session.ts` (approvals),
    `prompt.ts`
- `src/server/` — the headless server: `cli.ts` (commands), `config.ts` (env settings), `server.ts` (hub + worker + web), `entry.ts`; built by `vite.server.config.ts`
- `deploy/` — systemd unit, env file and Debian maintainer scripts for the server package
- `src/main/preload.ts` — typed bridge to the renderer
- `src/renderer/` — React UI (Jobs, Mappings, Editor, History, Settings)
- `src/shared/` — types and pure logic shared by both sides: validation, path
  safety, schedule maths, undo planning

See [TODO.md](TODO.md) for the current backlog.

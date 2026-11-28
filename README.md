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
- **Claude (MCP)** — manage FileShuttle by talking to Claude Code or any MCP
  client, over your tailnet. See [Talk to Claude (MCP)](#talk-to-claude-mcp).
- **Phone access** — open the whole UI from your phone over Tailscale (off by
  default). See [Open it from your phone](#open-it-from-your-phone).
- **Theming** — pick any [VisualAssault](https://github.com/gerp93/VisualAssault)
  color theme.

## Talk to Claude (MCP)

FileShuttle has a built-in MCP server, so Claude (Claude Code, Claude Desktop, or
any client that speaks MCP over HTTP) can read your mappings, jobs and history,
preview what a job would do, and set things up when you ask. It is **off until you
make a token**, and it is only reachable the way the phone UI is: on
`127.0.0.1` behind `tailscale serve` (never `tailscale funnel`). In the desktop app
it runs while Phone access is switched on; the headless server always serves it.

Make a token (shown once; only a hash is kept):

- desktop: **Settings → Claude access (MCP)**;
- server: `fileshuttle-server mcp-token create <name>` (also `list` and `revoke <name>`).

Then connect Claude Code:

```
claude mcp add --transport http fileshuttle https://<host>/mcp --header "Authorization: Bearer <token>"
```

Rules, enforced in code rather than by instructions:

- Every request needs the bearer token (a phone password session does not work
  here), a request with a foreign `Origin` header is refused, and the Tailscale
  allow list applies when one is set. Revoking a token cuts that client off at once.
- Tools are narrow: list/inspect workers, mappings, jobs and run history; check and
  list a folder (names, sizes and dates, never contents); validate and preview
  (dry runs); save mappings and jobs; switch a job on or off; run or cancel a job;
  delete a mapping or job. There is no way to touch a file directly.
- **A new job is saved switched off**; an existing job keeps its on/off state.
  Mappings get no schedule of their own.
- **Destructive actions need confirmation.** The first call does nothing and returns
  a description and a one-time code (valid 5 minutes, tied to that exact action).
  Claude must ask you, then repeat the call with `confirm`. This covers deleting a
  job or mapping, running or enabling a job that deletes, moves or overwrites, and
  saving changes that would make a switched-on job do that. Codes live in memory,
  so a restart voids them.
- Every tool call and every refused request is logged as one JSON line in
  `mcp-calls.log` in the data folder (token *name*, tool, arguments with the
  confirmation code hidden, result, duration). It rotates at about 5 MB.

File and folder *names* the tools return go to whichever model your client uses;
file contents never do.

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
database location, start with Windows, update check and "open in
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
fileshuttle-server worker         # a worker for a hub on another computer (see "Another computer as a worker")
fileshuttle-server workers list   # on the hub: the computers it knows, online or offline
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

### Another computer as a worker

The hub holds the definitions (mappings, jobs, schedules) and the history; a **worker** is a
computer that runs jobs against *its own* folders. A hub-only or `all` server can have any number of
paired computers besides its own, so one house server can run your jobs on your PC. The worker
always connects **out** to the hub's `tailscale serve` https address; nothing listens on the worker,
and the hub still listens on `127.0.0.1` only (never Funnel).

Pair a computer (once):

```bash
# on the hub: a one-time code for a computer you name (works once, expires in 15 minutes)
sudo -u fileshuttle-server fileshuttle-server workers pair "KVG PC"

# on that computer: pair it, then run it (the worker is the same program, a different command)
fileshuttle-server worker pair https://<hub>.<tailnet>.ts.net ABCDE-FGHJK
fileshuttle-server worker
```

- **Pairing and tokens.** The code is traded for a *worker token*: 32 random bytes, shown to the worker once. The hub keeps only
  a SHA-256 hash (a copy of its database holds nothing usable), and wrong codes are rate-limited. The worker keeps the token in
  `~/.config/fileshuttle-worker/worker.json` (mode 0600; set `FILESHUTTLE_WORKER_DIR` to move it) and sends it as a bearer token
  over https; it is never written to a log.
- **Revoking.** `fileshuttle-server workers revoke "KVG PC"` cuts the computer off within seconds (an open connection is dropped,
  the next request is refused); the worker stops, forgets its schedule and exits with status 3. Its mappings, jobs and history stay on
  the hub, and `workers repair "KVG PC"` makes a new code for the same computer.
- **A computer that is offline.** The hub shows a computer as offline when its connection is gone or it has been silent for 90
  seconds (a worker sends a heartbeat every 30), and refuses commands for it (run, preview, folder browsing) instead of queueing them.
  The worker itself keeps going: it stores the last schedule the hub sent, so scheduled and watched jobs keep running (and catch up after a
  restart) with the hub unreachable, and everything that finishes meanwhile waits in an **outbox** on disk. When the connection is back
  the outbox is delivered in order. Delivery is at-least-once and safe to repeat: each step has a `run_uid` and is stored once; a job's
  "last run" only moves forward. A run you started from the hub waits up to 10 minutes for a worker that dropped off to report back. The outbox keeps the newest
  20,000 reports.
- **Not in the pages yet.** The hub's web UI does not yet have a computer picker: until it does, a mapping or job is put on a
  computer through the API (`mappings:create` and `jobs:create` take the computer's id as a second argument; `workers:list` lists the ids).
- **Settings.** The hub's run settings (overwrite backup, unzip limits) are sent to every worker along with its schedule. A job's steps
  all run on the computer the job belongs to.
- **Trust.** Pairing makes the hub able to move, copy and delete files in any folder the worker's user can reach, so pair only
  your own hub, and run the worker as a user that can reach only what jobs need. If the hub has an *Allowed Tailscale logins* list,
  the worker's computer has to be signed in to Tailscale as one of those logins, like a phone. Anyone on the tailnet who can reach the hub
  can try pairing codes; five wrong tries from one place (twenty overall) block pairing for 15 minutes, and a code is ten characters
  from a 32-letter alphabet, so guessing one inside its 15 minutes is not realistic.
- **Version.** The two sides must speak the same worker protocol version; a mismatch is refused with a clear message.
- To run a worker as a service on Linux, use a normal user's systemd unit that runs `fileshuttle-server worker` with `Restart=on-failure`
  (status 3 means the hub revoked it, and is not restarted).

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
- **Hub and worker.** A *hub* (database, window,
  phone page) talks to a *worker* (scheduler, folder watchers, file mover) with
  JSON messages (`src/shared/workerProtocol.ts`). In the desktop app both live in one
  process over an in-process link, and nothing looks different from outside; a headless
  hub also accepts workers on other computers over the network (see "Another computer as a worker"). Every mapping, job and run belongs to a worker
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
  - `mcp/` — the MCP server: `mcpEndpoint.ts` (JSON-RPC over HTTP, auth), `tools.ts` (the only things it can do),
    `actions.ts` (what saving is allowed to change), `confirmations.ts`, `tokens.ts`, `callLog.ts`
- `src/server/` — the headless server: `cli.ts` (commands), `config.ts` (env settings), `server.ts` (hub + worker + web), `entry.ts`; built by `vite.server.config.ts`
- `deploy/` — systemd unit, env file and Debian maintainer scripts for the server package
- `src/main/preload.ts` — typed bridge to the renderer
- `src/renderer/` — React UI (Jobs, Mappings, Editor, History, Settings)
- `src/shared/` — types and pure logic shared by both sides: validation, path
  safety, schedule maths, undo planning

See [TODO.md](TODO.md) for the current backlog.

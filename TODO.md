# TODO

This app's own backlog — not a KVG_Standards compliance checklist. Just what's not done.

## Next

- Install the server on the Holocron (the owner's step): the `.deb`, a password, `tailscale serve`.
- Open question: which Debian version the Holocron runs (the `.deb` and its Node version must match it).

## Not finished / not verified

- Nothing in phase 5b was run on a real Windows machine: the DPAPI token, `reg` start at logon, the Windows
  `.exe` from the workflow (and whether its console window flashes at logon), and the desktop's
  remote-hub windows, menu item, navigation lock and "send setup" offer (tested through the main-process
  pieces only; never clicked through).
- Not checked: the `.deb` built and installed by the real workflow, a real tailnet, a real phone, MCP
  against a real client.
- Windows worker cannot delete to the Recycle Bin (deletes are refused).
- A web-push or notification path for finished runs; a PWA manifest/icon.
- Windows Task Scheduler integration for the desktop app itself (runs while closed).
- Watch mode for new files only; job preview across chained steps; macOS Trash undo; undo for merged unzip.
- Journal each file's outcome as it happens; parallelise safe copies; run `npm run smoke` in CI.

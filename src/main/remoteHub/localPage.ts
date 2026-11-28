/**
 * The small local page shown while this computer uses a remote hub: it is how you get back to
 * this computer's own settings, and what you see when the hub cannot be reached. It is a plain
 * page with one script and no network access (its own Content-Security-Policy forbids it), and
 * it talks only to the main process through `window.remoteHubAPI`.
 */
export function remoteHubPageHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>Remote hub</title>
<style>
  body{margin:0;font:14px system-ui,-apple-system,Segoe UI,sans-serif;background:#0d47a1;color:#fff;display:flex;justify-content:center}
  main{max-width:640px;width:100%;padding:24px;box-sizing:border-box}
  h1{font-size:20px;margin:0 0 4px} p{line-height:1.45} .muted{opacity:.8}
  .card{background:#0a3380;border-radius:8px;padding:14px 16px;margin:14px 0}
  .problem{background:#7f1d1d}
  button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer;margin:4px 6px 4px 0}
  button.primary{background:#fff;color:#0d47a1} button:disabled{opacity:.5;cursor:default}
  ul{padding-left:0;list-style:none;margin:6px 0} li{display:flex;gap:8px;align-items:center;margin:4px 0}
  li span{flex:1;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px}
  code{background:#0a3380;padding:1px 5px;border-radius:4px}
  .ok{color:#a7f3d0}
</style></head>
<body><main>
<h1>Remote hub</h1>
<p class="muted" id="where"></p>
<div class="card problem" id="problem" hidden></div>
<div class="card" id="status"></div>
<div id="actions"></div>
<div class="card">
  <strong>Folders this computer lets the hub use</strong>
  <p class="muted" id="foldersNote"></p>
  <ul id="folders"></ul>
  <button id="addFolder">Add a folder…</button>
</div>
<div class="card">
  <strong>Send this computer's setup to the hub</strong>
  <p class="muted">Copies this computer's jobs and mappings (not the run history) to the hub as this machine's own. Names the hub already has are skipped. Sent jobs are switched off until you turn them on there. This computer's own data stays as a backup.</p>
  <button id="send">Send my jobs and mappings</button>
  <div id="report"></div>
</div>
<div class="card">
  <strong>Stop using the remote hub</strong>
  <p class="muted">Deletes the saved token on this computer and brings this computer's own hub back. Nothing is removed on the hub; the machine stays listed there until you remove it.</p>
  <button id="off">Use this computer's own hub</button>
</div>
</main>
<script>
const api = window.remoteHubAPI;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let state = null;
const wantsRetry = location.hash === '#unreachable';
async function load() {
  state = await api.getState();
  $('where').textContent = state.hubUrl ? 'Hub: ' + state.hubUrl + ' · this computer is listed there as “' + state.name + '”.' : '';
  const prob = $('problem');
  const note = wantsRetry ? 'The hub could not be reached. Check that it is running and that this computer is on the same network (for example Tailscale), then try again.' : '';
  prob.hidden = !note;
  prob.textContent = note;
  $('status').innerHTML = state.connected
    ? '<span class="ok">Connected.</span> This computer is working for the hub.'
    : esc(state.problem || 'Not connected.');
  $('actions').innerHTML = '<button class="primary" id="retry">' + (wantsRetry ? 'Retry' : 'Open the hub') + '</button>';
  $('retry').onclick = async () => { $('retry').disabled = true; const r = await api.retry(); if (r && r.problem) { $('problem').hidden = false; $('problem').textContent = r.problem; $('retry').disabled = false; } };
  $('foldersNote').innerHTML = state.allowedFolders.length
    ? 'The hub can read and change files only inside these folders. Everything else is refused.'
    : '<strong>No folders are allowed, so this computer refuses every folder.</strong> Add at least one before running jobs from the hub.';
  $('folders').innerHTML = state.allowedFolders.map((f, i) => '<li><span>' + esc(f) + '</span><button data-i="' + i + '">Remove</button></li>').join('');
  for (const b of $('folders').querySelectorAll('button')) b.onclick = async () => { const list = state.allowedFolders.filter((_, i) => i !== Number(b.dataset.i)); await api.setAllowedFolders(list); load(); };
}
$('addFolder').onclick = async () => { const f = await api.pickFolder(); if (f) { await api.setAllowedFolders([...state.allowedFolders, f]); load(); } };
$('send').onclick = async () => {
  $('send').disabled = true; $('report').textContent = 'Sending…';
  try {
    const r = await api.sendSetup();
    const lines = ['Sent ' + r.mappingsSent + ' mappings and ' + r.jobsSent + ' jobs.'];
    for (const s of r.mappingsSkipped) lines.push('Skipped mapping “' + s.name + '”: ' + s.reason);
    for (const s of r.jobsSkipped) lines.push('Skipped job “' + s.name + '”: ' + s.reason);
    $('report').innerHTML = lines.map((l) => '<p>' + esc(l) + '</p>').join('');
  } catch (e) { $('report').textContent = (e && e.message) || 'Could not send the setup.'; }
  $('send').disabled = false;
};
$('off').onclick = async () => { $('off').disabled = true; const r = await api.useLocal(); if (r && r.cancelled) $('off').disabled = false; };
load();
setInterval(load, 5000);
</script></body></html>`;
}

export function remoteHubPageUrl(unreachable: boolean): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(remoteHubPageHtml())}${unreachable ? '#unreachable' : ''}`;
}

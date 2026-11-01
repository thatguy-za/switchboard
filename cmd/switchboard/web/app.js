'use strict';

const app = document.getElementById('app');
let state = null;
let shell = null;    // the signed-in workspace, built once so open terminals survive
let overlay = null;  // full-screen cards (password change, 2FA) shown over the workspace

const messages = {
  invalid_credentials: 'Wrong username or password.',
  invalid_code: 'That code is not valid.',
  invalid_recovery_key: 'That recovery key is not valid.',
  invalid_username: 'Usernames are 2-32 characters: letters, digits, dot, dash, underscore.',
  weak_password: 'Use at least 12 characters.',
  username_taken: 'That username is taken.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  setup_done: 'Setup has already been completed.',
  last_admin: 'You cannot delete the last admin.',
  cannot_delete_self: 'You cannot delete your own account.',
  '2fa_required': 'Two-factor authentication is required by an admin.',
  unauthorized: 'Your session has ended. Sign in again.',
};

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && data.error === 'unauthorized' && shell) refresh();
    const err = new Error(messages[data.error] || 'Something went wrong.');
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = (sel, root) => (root || (overlay && !overlay.hidden ? overlay : app)).querySelector(sel);

function show(html) {
  const target = shell ? overlay : app;
  if (shell) overlay.hidden = false;
  target.innerHTML = html;
  const first = target.querySelector('input:not([type=checkbox])');
  if (first) first.focus();
}

function closeOverlay() {
  if (!overlay) return;
  overlay.hidden = true;
  overlay.innerHTML = '';
}

// Bind a form: handler gets the field values keyed by name; thrown errors show under the form.
function onSubmit(sel, handler) {
  const form = $(sel);
  if (!form) return;
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const out = form.querySelector('.err');
    const btn = form.querySelector('button.primary');
    const vals = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type=checkbox]').forEach(c => { vals[c.name] = c.checked; });
    if (out) out.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await handler(vals, form);
    } catch (e) {
      if (e.status === 401 && e.code === 'unauthorized') return refresh();
      if (out) out.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function onClick(sel, handler) {
  app.querySelectorAll(sel).forEach(el => el.addEventListener('click', handler));
}

async function refresh() {
  state = await api('GET', '/state');
  route();
}

function route() {
  const u = state.user;
  if (shell && !(u && !u.must_change && !u.needs_2fa_setup)) teardownShell();
  if (!state.setup_done) return viewSetup();
  if (!u) return viewLogin();
  if (u.must_change) return viewChangePassword(true);
  if (u.needs_2fa_setup) return viewTwoFactorSetup(true);
  if (shell) { closeOverlay(); renderSettings(); updateNav(); } else buildShell();
}

function card(title, inner, wide) {
  return `<div class="center"><div class="box${wide ? ' wide' : ''}"><h1>${esc(title)}</h1>${inner}</div></div>`;
}

/* ---------- first run, sign in, recovery ---------- */

function viewSetup() {
  show(card('Set up Switchboard', `
    <p class="muted">Create the owner account. It becomes the first admin and gets its own encrypted vault.</p>
    <form id="f">
      <label>Username<input type="text" name="username" autocomplete="username" required></label>
      <label>Password<input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
      <label>Confirm password<input type="password" name="confirm" autocomplete="new-password" required></label>
      <div class="actions"><button class="primary">Create account</button></div>
      <p class="err"></p>
    </form>`));
  onSubmit('#f', async v => {
    if (v.password !== v.confirm) throw new Error('Passwords do not match.');
    const r = await api('POST', '/setup', { username: v.username, password: v.password });
    viewRecoveryKey(r.recovery_key);
  });
}

function viewRecoveryKey(key) {
  show(card('Save your recovery key', `
    <p>This is the only way to unlock your vault if you forget your password. It is shown once.
    Without it, a lost password means the vault's contents are gone.</p>
    <p class="secret">${esc(key)}</p>
    <form id="f">
      <label class="check"><input type="checkbox" name="saved" required> I have stored this key somewhere safe</label>
      <div class="actions"><button type="button" id="copy">Copy</button><button class="primary">Continue</button></div>
    </form>`, true));
  $('#copy').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(key));
  onSubmit('#f', () => refresh());
}

function viewLogin() {
  show(card('Sign in', `
    <form id="f">
      <label>Username<input type="text" name="username" autocomplete="username" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="actions"><button class="primary">Sign in</button>
        <button type="button" class="link" id="recover">Forgot password?</button></div>
      <p class="err"></p>
    </form>`));
  $('#recover').addEventListener('click', viewRecover);
  onSubmit('#f', async v => {
    const r = await api('POST', '/login', v);
    if (r.need_2fa) return viewSecondFactor();
    await refresh();
  });
}

function viewSecondFactor() {
  show(card('Two-factor code', `
    <p class="muted">Enter the 6-digit code from your authenticator app, or a backup code.</p>
    <form id="f">
      <label>Code<input type="text" name="code" autocomplete="one-time-code" inputmode="text" required></label>
      <div class="actions"><button class="primary">Verify</button>
        <button type="button" class="link" id="back">Back</button></div>
      <p class="err"></p>
    </form>`));
  $('#back').addEventListener('click', viewLogin);
  onSubmit('#f', async v => { await api('POST', '/login/2fa', v); await refresh(); });
}

function viewRecover() {
  show(card('Recover with your recovery key', `
    <p class="muted">Enter the recovery key from when you set up your vault, and choose a new password.</p>
    <form id="f">
      <label>Username<input type="text" name="username" autocomplete="username" required></label>
      <label>Recovery key<input type="text" name="recovery_key" autocomplete="off" required></label>
      <label>New password<input type="password" name="new_password" autocomplete="new-password" minlength="12" required></label>
      <div class="actions"><button class="primary">Set new password</button>
        <button type="button" class="link" id="back">Back</button></div>
      <p class="err"></p>
    </form>`));
  $('#back').addEventListener('click', viewLogin);
  onSubmit('#f', async v => { await api('POST', '/recover', v); viewLogin(); });
}

/* ---------- forced steps ---------- */

function viewChangePassword(forced) {
  show(card(forced ? 'Choose a new password' : 'Change password', `
    ${forced ? '<p class="muted">An admin gave you a temporary password. Replace it to continue.</p>' : ''}
    <form id="f">
      <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="new" autocomplete="new-password" minlength="12" required></label>
      <div class="actions"><button class="primary">Change password</button>
        ${forced ? '<button type="button" class="link" id="out">Sign out</button>' : '<button type="button" class="link" id="back">Cancel</button>'}</div>
      <p class="err"></p>
    </form>`));
  const out = $('#out'); if (out) out.addEventListener('click', signOut);
  const back = $('#back'); if (back) back.addEventListener('click', closeOverlay);
  onSubmit('#f', async v => {
    const r = await api('POST', '/password', v);
    if (r.recovery_key) return viewRecoveryKey(r.recovery_key);
    await refresh();
  });
}

async function viewTwoFactorSetup(forced) {
  let info;
  try { info = await api('POST', '/2fa/setup'); } catch (e) { return refresh(); }
  show(card('Set up two-factor authentication', `
    ${forced ? '<p class="muted">An admin requires 2FA for all accounts.</p>' : ''}
    <img class="qr" src="${info.qr}" width="220" height="220" alt="QR code for your authenticator app">
    <p class="muted">Can't scan? Enter this key by hand:</p>
    <p class="secret">${esc(info.secret)}</p>
    <form id="f">
      <label>Code from the app<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
      <div class="actions"><button class="primary">Turn on 2FA</button>
        ${forced ? '<button type="button" class="link" id="out">Sign out</button>' : '<button type="button" class="link" id="back">Cancel</button>'}</div>
      <p class="err"></p>
    </form>`, true));
  const out = $('#out'); if (out) out.addEventListener('click', signOut);
  const back = $('#back'); if (back) back.addEventListener('click', refresh);
  onSubmit('#f', async v => {
    const r = await api('POST', '/2fa/enable', v);
    viewBackupCodes(r.backup_codes);
  });
}

function viewBackupCodes(codes) {
  show(card('Backup codes', `
    <p>Each code works once if you lose your authenticator. They are shown only now.</p>
    <div class="codes">${codes.map(c => `<span>${esc(c)}</span>`).join('')}</div>
    <form id="f">
      <label class="check"><input type="checkbox" name="saved" required> I have saved these codes</label>
      <div class="actions"><button type="button" id="copy">Copy</button><button class="primary">Done</button></div>
    </form>`, true));
  $('#copy').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(codes.join('\n')));
  onSubmit('#f', () => refresh());
}

/* ---------- signed in ---------- */

async function signOut() {
  try { await api('POST', '/logout'); } catch (e) { /* already out */ }
  await refresh();
}

async function signOutEverywhere() {
  await api('POST', '/logout-all');
  await refresh();
}

function teardownShell() {
  destroyWorkspace();
  shell = null;
  overlay = null;
}

function buildShell() {
  app.innerHTML = `
    <div id="shell">
      <header>
        <strong>Switchboard</strong>
        <nav id="nav">
          <button data-view="terminals">Terminals</button>
          <button data-view="identities">Identities</button>
          <button data-view="settings">Settings<span id="navflag" class="flag" hidden>!</span></button>
        </nav>
        <div class="who"><span class="muted" id="whoami"></span><button id="out">Sign out</button></div>
      </header>
      <div id="view-terminals" class="view"></div>
      <div id="view-identities" class="view" hidden></div>
      <div id="view-settings" class="view" hidden></div>
    </div>
    <div id="overlay" class="overlay" hidden></div>`;
  shell = $('#shell', app);
  overlay = $('#overlay', app);
  $('#nav', shell).addEventListener('click', ev => {
    const b = ev.target.closest('[data-view]');
    if (b) showView(b.dataset.view);
  });
  $('#out', shell).addEventListener('click', signOut);
  mountWorkspace($('#view-terminals', shell), $('#view-identities', shell));
  renderSettings();
  updateNav();
  showView('terminals');
}

function showView(name) {
  if (!shell) return;
  for (const v of ['terminals', 'identities', 'settings']) {
    $('#view-' + v, shell).hidden = v !== name;
  }
  shell.querySelectorAll('#nav [data-view]').forEach(b => {
    b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
  });
  if (name === 'terminals') requestAnimationFrame(() => { fitActive(); if (WS.active) WS.active.term.focus(); });
}

function updateNav() {
  const u = state.user;
  $('#whoami', shell).textContent = u.username + (u.role === 'admin' ? ' (admin)' : '');
  $('#navflag', shell).hidden = !(u.role === 'admin' && state.key_backup_pending);
}

function renderSettings() {
  const u = state.user;
  const isAdmin = u.role === 'admin';
  const prefs = termPrefs();
  const root = $('#view-settings', shell);
  const fonts = [['System monospace', DEFAULT_FONT], ['Menlo', 'Menlo, monospace'], ['Consolas', 'Consolas, monospace'], ['Courier New', '"Courier New", monospace']];
  root.innerHTML = `
    <main>
      ${isAdmin && state.key_backup_pending ? `
      <div class="banner" id="keybanner">
        <p><strong>Back up the master key.</strong> Switchboard generated one when it first started. Every stored secret
        is encrypted with it, so if it is lost, no vault can be opened. Store a copy away from this server.</p>
        <form id="keyform" class="inline">
          <label>Your password<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="primary">Download key</button>
        </form>
        <p class="err" id="keyerr"></p>
        <label class="check"><input type="checkbox" id="keydone"> I have stored the key safely</label>
      </div>` : ''}
      <section id="account"><h2>Account</h2>
        <div class="actions"><button id="pw">Change password</button>
          <button id="all">Sign out everywhere</button></div>
        ${twoFactorBlock(u)}
      </section>
      <section><h2>Terminal</h2>
        <form id="prefs" class="inline">
          <label>Font<select name="font">${fonts.map(f => `<option value='${esc(f[1])}'${f[1] === prefs.font ? ' selected' : ''}>${esc(f[0])}</option>`).join('')}</select></label>
          <label class="narrow">Size<input type="number" name="size" min="10" max="28" value="${esc(prefs.size)}"></label>
        </form>
        <p class="muted">Saved in this browser. Colours are set per host.</p>
      </section>
      ${isAdmin ? '<section id="admin"><h2>Users</h2><div id="users">Loading…</div></section>' : ''}
    </main>`;
  $('#pw', root).addEventListener('click', () => viewChangePassword(false));
  $('#all', root).addEventListener('click', signOutEverywhere);
  const prefsForm = $('#prefs', root);
  prefsForm.addEventListener('change', () => {
    const size = Math.min(28, Math.max(10, Number(prefsForm.size.value) || 14));
    saveTermPrefs({ font: prefsForm.font.value, size });
  });
  bindTwoFactor(u);
  if (isAdmin) { bindKeyBackup(); loadUsers(); }
}

function twoFactorBlock(u) {
  if (!u.totp_enabled) {
    return `<h2 class="sp">Two-factor authentication</h2>
      <p class="muted">Off.</p><div class="actions"><button id="tf-on" class="primary">Set up 2FA</button></div>`;
  }
  return `<h2 class="sp">Two-factor authentication</h2>
    <p class="muted">On. ${u.backup_codes_left} backup code${u.backup_codes_left === 1 ? '' : 's'} left.</p>
    <form id="tf" class="inline">
      <label>Password to confirm<input type="password" name="password" autocomplete="current-password" required></label>
      <button type="button" id="tf-codes">New backup codes</button>
      ${state.require_2fa ? '' : '<button type="button" id="tf-off" class="danger">Turn off</button>'}
    </form><p class="err" id="tferr"></p>`;
}

function bindTwoFactor(u) {
  const on = $('#tf-on');
  if (on) on.addEventListener('click', () => viewTwoFactorSetup(false));
  if (!u.totp_enabled) return;
  const act = (sel, fn) => $(sel).addEventListener('click', async () => {
    const pw = $('#tf input[name=password]');
    if (!pw.value) { pw.focus(); return; }
    $('#tferr').textContent = '';
    try { await fn(pw.value); } catch (e) { $('#tferr').textContent = e.message; }
  });
  act('#tf-codes', async password => viewBackupCodes((await api('POST', '/2fa/backup-codes', { password })).backup_codes));
  const off = $('#tf-off');
  if (off) act('#tf-off', async password => { await api('POST', '/2fa/disable', { password }); await refresh(); });
}

function bindKeyBackup() {
  const form = $('#keyform');
  if (!form) return;
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    $('#keyerr').textContent = '';
    try {
      const r = await api('POST', '/admin/master-key', { password: form.password.value });
      const url = URL.createObjectURL(new Blob([r.master_key + '\n'], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'switchboard-master.key' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      form.password.value = '';
    } catch (e) { $('#keyerr').textContent = e.message; }
  });
  $('#keydone').addEventListener('change', async ev => {
    if (!ev.target.checked) return;
    await api('POST', '/admin/key-backup-confirmed');
    state.key_backup_pending = false;
    $('#keybanner').remove();
  });
}

async function loadUsers() {
  const box = $('#users');
  let users;
  try { users = await api('GET', '/admin/users'); } catch (e) { box.textContent = e.message; return; }
  const me = state.user.id;
  box.innerHTML = `
    <table>
      <thead><tr><th>User</th><th>Role</th><th>2FA</th><th></th></tr></thead>
      <tbody>${users.map(u => `
        <tr><td>${esc(u.username)}${u.must_change ? ' <span class="muted">(temporary password)</span>' : ''}</td>
          <td>${esc(u.role)}</td><td>${u.totp_enabled ? 'on' : 'off'}</td>
          <td class="r">
            ${u.totp_enabled ? `<button data-reset="${esc(u.id)}">Reset 2FA</button>` : ''}
            ${u.id === me ? '' : `<button class="danger" data-del="${esc(u.id)}" data-name="${esc(u.username)}">Delete</button>`}
          </td></tr>`).join('')}
      </tbody>
    </table>
    <h2 class="sp">Add user</h2>
    <form id="newuser" class="inline">
      <label>Username<input type="text" name="username" autocomplete="off" required></label>
      <label>Temporary password<input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
      <label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
      <button class="primary">Add</button>
    </form>
    <p class="err" id="uerr"></p>
    <label class="check"><input type="checkbox" id="req2fa" ${state.require_2fa ? 'checked' : ''}> Require 2FA for everyone</label>`;
  const fail = e => { $('#uerr').textContent = e.message; };
  $('#newuser').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('POST', '/admin/users', { username: f.username.value, password: f.password.value, role: f.role.value });
      loadUsers();
    } catch (e) { fail(e); }
  });
  box.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Reset two-factor authentication for this user? They will be signed out.')) return;
    try { await api('POST', '/admin/users/' + b.dataset.reset + '/reset-2fa'); loadUsers(); } catch (e) { fail(e); }
  }));
  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete ' + b.dataset.name + '? Their vault and everything in it is destroyed.')) return;
    try { await api('DELETE', '/admin/users/' + b.dataset.del); loadUsers(); } catch (e) { fail(e); }
  }));
  $('#req2fa').addEventListener('change', async ev => {
    try {
      await api('POST', '/admin/require-2fa', { enabled: ev.target.checked });
      state.require_2fa = ev.target.checked;
    } catch (e) { ev.target.checked = !ev.target.checked; fail(e); }
  });
}

refresh().catch(() => { app.textContent = 'Could not reach the server.'; });

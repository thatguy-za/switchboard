'use strict';

/* Sign in and setup, the application shell, and Settings. */

const app = document.getElementById('app');
let state = null;
let shell = null; // the signed-in workspace, built once so open terminals survive navigation
let settingsTab = 'account';

const messages = {
  invalid_credentials: 'Wrong username or password.',
  invalid_code: 'That code is not valid.',
  invalid_recovery_key: 'That recovery key is not valid.',
  invalid_username: 'Usernames are 2 to 32 characters: letters, digits, dot, dash or underscore.',
  weak_password: 'Enter a password.',
  username_taken: 'That username is taken.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  setup_done: 'Setup has already been completed.',
  last_admin: 'You cannot delete the last admin.',
  cannot_delete_self: 'You cannot delete your own account.',
  '2fa_required': 'An admin requires two-factor authentication.',
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

const $ = (sel, root = app) => root.querySelector(sel);

function show(html) {
  app.innerHTML = html;
  const first = app.querySelector('input:not([type=checkbox])');
  if (first) first.focus();
}

// Binds a full-page form. The handler gets the field values; a thrown error shows under the form.
function onSubmit(sel, handler) {
  const form = $(sel);
  if (!form) return;
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const out = form.querySelector('.err');
    const btn = form.querySelector('button.primary');
    const vals = Object.fromEntries(new FormData(form));
    if (out) out.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await handler(vals, form);
    } catch (e) {
      if (out) out.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
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
  if (u.must_change) return viewChangePassword();
  if (u.needs_2fa_setup) return viewTwoFactorSetup();
  if (shell) { renderSettings(); updateNav(); } else buildShell();
}

/* ---------- sign in, setup, recovery (full pages) ---------- */

function authPage(inner) {
  return `<div class="auth"><div class="auth-box"><div class="wordmark">${icon('logo')}Switchboard</div>${inner}</div></div>`;
}

function viewSetup() {
  show(authPage(`
    <div><h1>Set up Switchboard</h1><p class="sub">Create the owner account. It becomes the first admin and gets its own encrypted vault.</p></div>
    <form id="f">
      <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="off" required></label>
      <label>Password<input type="password" name="password" autocomplete="new-password" required></label>
      <label>Confirm password<input type="password" name="confirm" autocomplete="new-password" required></label>
      <p class="err"></p>
      <button class="primary block">Create account</button>
    </form>`));
  onSubmit('#f', async v => {
    if (v.password !== v.confirm) throw new Error('Passwords do not match.');
    const r = await api('POST', '/setup', { username: v.username, password: v.password });
    viewRecoveryKey(r.recovery_key);
  });
}

function viewRecoveryKey(key) {
  show(authPage(`
    <div><h1>Save your recovery key</h1>
      <p class="sub">It is the only way to unlock your vault if you forget your password, and it is shown once. Without it, a lost password means the vault's contents are gone.</p></div>
    <form id="f">
      ${codeBlock(key)}
      <label class="check"><input type="checkbox" name="saved" required> I have stored this key somewhere safe</label>
      <div class="row-gap"><button type="button" id="copy" class="quiet">${icon('copy')}Copy</button><span class="grow"></span><button class="primary">Continue</button></div>
    </form>`));
  $('#copy').addEventListener('click', () => copyText(key));
  onSubmit('#f', () => refresh());
}

function viewLogin() {
  show(authPage(`
    <div><h1>Sign in</h1></div>
    <form id="f">
      <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="off" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="err"></p>
      <button class="primary block">Sign in</button>
      <div class="auth-foot"><span></span><button type="button" class="link" id="recover">Forgot your password?</button></div>
    </form>`));
  $('#recover').addEventListener('click', viewRecover);
  onSubmit('#f', async v => {
    const r = await api('POST', '/login', v);
    if (r.need_2fa) return viewSecondFactor();
    await refresh();
  });
}

function viewSecondFactor() {
  show(authPage(`
    <div><h1>Two-factor code</h1><p class="sub">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p></div>
    <form id="f">
      <label>Code<input type="text" name="code" autocomplete="one-time-code" autocapitalize="off" required></label>
      <p class="err"></p>
      <button class="primary block">Verify</button>
      <div class="auth-foot"><button type="button" class="link" id="back">Back to sign in</button></div>
    </form>`));
  $('#back').addEventListener('click', viewLogin);
  onSubmit('#f', async v => { await api('POST', '/login/2fa', v); await refresh(); });
}

function viewRecover() {
  show(authPage(`
    <div><h1>Recover your vault</h1><p class="sub">Enter the recovery key from when you set up your vault, and choose a new password.</p></div>
    <form id="f">
      <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="off" required></label>
      <label>Recovery key<input type="text" name="recovery_key" autocomplete="off" autocapitalize="off" class="mono" required></label>
      <label>New password<input type="password" name="new_password" autocomplete="new-password" required></label>
      <p class="err"></p>
      <button class="primary block">Set new password</button>
      <div class="auth-foot"><button type="button" class="link" id="back">Back to sign in</button></div>
    </form>`));
  $('#back').addEventListener('click', viewLogin);
  onSubmit('#f', async v => { await api('POST', '/recover', v); toast('Password changed. Sign in with it now.'); viewLogin(); });
}

// An admin gave this account a temporary password.
function viewChangePassword() {
  show(authPage(`
    <div><h1>Choose a new password</h1><p class="sub">An admin gave you a temporary password. Replace it to continue.</p></div>
    <form id="f">
      <label>Temporary password<input type="password" name="current" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="new" autocomplete="new-password" required></label>
      <p class="err"></p>
      <button class="primary block">Change password</button>
      <div class="auth-foot"><button type="button" class="link" id="out">Sign out</button></div>
    </form>`));
  $('#out').addEventListener('click', signOut);
  onSubmit('#f', async v => {
    const r = await api('POST', '/password', v);
    if (r.recovery_key) return viewRecoveryKey(r.recovery_key);
    await refresh();
  });
}

// An admin requires two-factor authentication for everyone.
async function viewTwoFactorSetup() {
  let info;
  try { info = await api('POST', '/2fa/setup'); } catch (e) { return refresh(); }
  show(authPage(`
    <div><h1>Set up two-factor authentication</h1><p class="sub">An admin requires it for all accounts. Scan the code with an authenticator app.</p></div>
    <form id="f">
      <img class="qr" src="${info.qr}" width="200" height="200" alt="QR code for your authenticator app">
      <div><p class="small muted">Can't scan? Enter this key by hand:</p>${codeBlock(info.secret)}</div>
      <label>Code from the app<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
      <p class="err"></p>
      <button class="primary block">Turn on two-factor</button>
      <div class="auth-foot"><button type="button" class="link" id="out">Sign out</button></div>
    </form>`));
  $('#out').addEventListener('click', signOut);
  onSubmit('#f', async v => {
    const r = await api('POST', '/2fa/enable', v);
    viewBackupCodes(r.backup_codes);
  });
}

function viewBackupCodes(codes) {
  show(authPage(`
    <div><h1>Backup codes</h1><p class="sub">Each code works once if you lose your authenticator. They are shown only now.</p></div>
    <form id="f">
      ${codeGrid(codes)}
      <label class="check"><input type="checkbox" name="saved" required> I have saved these codes</label>
      <div class="row-gap"><button type="button" id="copy" class="quiet">${icon('copy')}Copy</button><span class="grow"></span><button class="primary">Done</button></div>
    </form>`));
  $('#copy').addEventListener('click', () => copyText(codes.join('\n')));
  onSubmit('#f', () => refresh());
}

/* ---------- dialogs used from inside the app ---------- */

function recoveryKeyDialog(key) {
  const d = dialog('Save your recovery key', `
    ${codeBlock(key)}
    <label class="check"><input type="checkbox" name="saved" required> I have stored this key somewhere safe</label>`, {
    description: 'It is the only way to unlock your vault if you forget your password, and it is shown once.',
    submitLabel: 'Continue', extra: '<button type="button" class="quiet" data-copy>Copy</button>', onSubmit: () => {},
  });
  d.querySelector('[data-copy]').addEventListener('click', () => copyText(key));
}

function backupCodesDialog(codes) {
  const d = dialog('Backup codes', `${codeGrid(codes)}
    <label class="check"><input type="checkbox" name="saved" required> I have saved these codes</label>`, {
    description: 'Each code works once if you lose your authenticator. They are shown only now.',
    submitLabel: 'Done', extra: '<button type="button" class="quiet" data-copy>Copy</button>', onSubmit: () => {},
  });
  d.querySelector('[data-copy]').addEventListener('click', () => copyText(codes.join('\n')));
}

function changePasswordDialog() {
  dialog('Change password', `
    <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
    <label>New password<input type="password" name="new" autocomplete="new-password" required></label>`, {
    description: 'Your vault and everything saved in it stay readable.', submitLabel: 'Change password',
    onSubmit: async fd => {
      const r = await api('POST', '/password', { current: fd.get('current'), new: fd.get('new') });
      toast('Password changed');
      if (r.recovery_key) setTimeout(() => recoveryKeyDialog(r.recovery_key), 200);
    },
  });
}

async function twoFactorSetupDialog() {
  let info;
  try { info = await api('POST', '/2fa/setup'); } catch (e) { toast(e.message, 'err'); return; }
  dialog('Set up two-factor authentication', `
    <img class="qr" src="${info.qr}" width="188" height="188" alt="QR code for your authenticator app">
    <div><p class="small muted">Can't scan? Enter this key by hand:</p>${codeBlock(info.secret)}</div>
    <label>Code from the app<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required></label>`, {
    description: 'Scan the code with an authenticator app, then enter the 6-digit code it shows.', submitLabel: 'Turn on',
    onSubmit: async fd => {
      const r = await api('POST', '/2fa/enable', { code: fd.get('code') });
      await refresh();
      setTimeout(() => backupCodesDialog(r.backup_codes), 200);
    },
  });
}

function addUserDialog() {
  dialog('Add a user', `
    <label>Username<input type="text" name="username" autocomplete="off" autocapitalize="off" required></label>
    <label>Temporary password<input type="password" name="password" autocomplete="new-password" required></label>
    <label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>`, {
    description: 'They will be asked to choose their own password the first time they sign in.', submitLabel: 'Add user',
    onSubmit: async fd => {
      await api('POST', '/admin/users', { username: fd.get('username'), password: fd.get('password'), role: fd.get('role') });
      toast('User added');
      renderSettingsBody();
    },
  });
}

/* ---------- Tailscale (Settings → Server) ---------- */

let tsTimer = null;

async function renderTailscale(host) {
  clearTimeout(tsTimer);
  let t;
  try { t = await api('GET', '/admin/tailscale'); } catch (e) { host.innerHTML = notice('alert-triangle', esc(e.message)); return; }
  if (!host.isConnected || settingsTab !== 'server') return;
  const up = t.state === 'connected';
  const status = {
    off: tag('Off'), needs_key: tag('Needs a key', 'warn'), starting: tag('Connecting…'),
    connected: tag('Connected', 'acc'), error: tag('Problem', 'warn'),
  }[t.state] || '';
  const where = up ? `${t.name ? `<code>${esc(t.name)}</code> · ` : ''}${esc((t.ips || []).join(', '))}` : '';
  const url = up && t.serve_ui ? `<div>Web UI: <code>http://${esc(t.hostname)}:${t.port}</code> from any device on your tailnet</div>` : '';
  const problem = t.error ? `<div class="err">${esc(t.error)}</div>` : '';
  const configure = () => tailscaleDialog(t, () => renderTailscale(host));
  host.innerHTML = panel(
    settingRow(`Tailscale ${status}`, `Reach SSH and RDP hosts by their tailnet address or name, and optionally open Switchboard from your tailnet.${where ? `<div>${where}</div>` : ''}${url}${problem}`,
      `${button('Configure', { icon: 'settings', attrs: 'id="tsedit"' })}${switchControl({ id: 'tson', checked: t.enabled, label: 'Use Tailscale' })}`) +
    (t.has_state ? settingRow('Remove from tailnet', 'Log this device out of Tailscale and forget it. You will need a new auth key to join again.',
      button('Remove', { kind: 'danger', attrs: 'id="tsrm"' })) : ''));
  $('#tsedit', host).addEventListener('click', configure);
  $('#tson', host).addEventListener('change', async ev => {
    if (ev.target.checked && !t.has_state) { ev.target.checked = false; configure(); return; }
    try {
      await api('POST', '/admin/tailscale', { enabled: ev.target.checked, hostname: t.hostname, serve_ui: t.serve_ui });
    } catch (e) { toast(e.message, 'err'); }
    renderTailscale(host);
  });
  const rm = $('#tsrm', host);
  if (rm) rm.addEventListener('click', () => confirmDialog('Remove from tailnet?', 'This device is logged out of Tailscale and forgotten. Hosts reached over the tailnet stop working until you join again.', 'Remove', async () => {
    await api('POST', '/admin/tailscale/remove');
    toast('Removed from the tailnet');
    renderTailscale(host);
  }));
  if (t.state === 'starting') tsTimer = setTimeout(() => renderTailscale(host), 2000);
}

function tailscaleDialog(t, done) {
  dialog(t.enabled ? 'Tailscale settings' : 'Connect to Tailscale', `
    <label>Device name<input type="text" name="hostname" value="${esc(t.hostname)}" maxlength="63" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" autocapitalize="off" required></label>
    <label>Auth key<input type="password" name="auth_key" autocomplete="off" ${t.has_state ? '' : 'required'}
      placeholder="${t.has_state ? 'Only needed to join again' : 'tskey-auth-…'}"></label>
    ${checkField('serve_ui', 'Open the web UI on the tailnet', `Serves this page on port ${t.port} of the device name above. Anyone on your tailnet who can reach it can sign in.`, '', t.serve_ui)}`, {
    description: 'Create an auth key in the Tailscale admin console under Settings → Keys. It is used once to join and is not stored.',
    submitLabel: t.enabled ? 'Save' : 'Connect',
    onSubmit: async fd => {
      await api('POST', '/admin/tailscale', { enabled: true, hostname: fd.get('hostname'), serve_ui: fd.get('serve_ui') !== null, auth_key: fd.get('auth_key') });
      toast('Tailscale is connecting');
      done();
    },
  });
}

/* ---------- the application shell ---------- */

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
}

function buildShell() {
  app.innerHTML = `
    <div class="shell" id="shell">
      <aside class="side" id="side">
        <div class="side-head"><div class="wordmark">${icon('logo')}Switchboard</div>
          ${iconButton('plus', 'New host', 'id="add-host"')}${iconButton('folder-plus', 'New folder', 'id="add-folder"')}</div>
        <button class="find" id="find">${icon('search')}<span class="grow">Search or connect</span><span class="kbd">${IS_MAC ? '⌘K' : 'Ctrl K'}</span></button>
        <div class="tree" id="tree"></div>
        <div class="side-foot">
          <button class="nav" data-view="identities">${icon('key')}Identities</button>
          <button class="nav" data-view="settings">${icon('settings')}Settings<span class="badge" id="navflag" hidden></span></button>
          <div class="me"><span id="avatar"></span><span class="grow" id="whoami"></span>${iconButton('logout', 'Sign out', 'id="out"')}</div>
        </div>
      </aside>
      <div class="scrim" id="scrim"></div>
      <div class="main">
        <div class="topbar">${iconButton('menu-2', 'Open menu', 'id="menu"')}<div class="wordmark">${icon('logo')}Switchboard</div></div>
        <div class="view" id="view-terminals"></div>
        <div class="view" id="view-identities" hidden></div>
        <div class="view" id="view-settings" hidden></div>
      </div>
    </div>`;
  shell = $('#shell');
  shell.querySelectorAll('.nav[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#out', shell).addEventListener('click', signOut);
  $('#menu', shell).addEventListener('click', () => toggleSide(true));
  $('#scrim', shell).addEventListener('click', () => toggleSide(false));
  mountWorkspace(shell, $('#view-terminals', shell), $('#view-identities', shell));
  renderSettings();
  updateNav();
  showView('terminals');
}

function toggleSide(open) {
  $('#side', shell).classList.toggle('open', open);
  $('#scrim', shell).classList.toggle('show', open);
}

function showView(name) {
  if (!shell) return;
  toggleSide(false);
  for (const v of ['terminals', 'identities', 'settings']) $('#view-' + v, shell).hidden = v !== name;
  shell.querySelectorAll('.nav[data-view]').forEach(b => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (name === 'terminals') requestAnimationFrame(() => { fitActive(); if (WS.active) sessFocus(WS.active.active); });
}

function updateNav() {
  const u = state.user;
  $('#whoami', shell).textContent = u.username;
  $('#avatar', shell).innerHTML = avatar(u.username);
  $('#navflag', shell).hidden = !(u.role === 'admin' && state.key_backup_pending);
}

/* ---------- settings ---------- */

function renderSettings() {
  const root = $('#view-settings', shell);
  const admin = state.user.role === 'admin';
  const tabs = [['account', 'Account', 'user'], ['security', 'Security', 'shield-lock'], ['appearance', 'Appearance', 'palette']];
  if (admin) tabs.push(['users', 'Users', 'users'], ['server', 'Server', 'server']);
  if (!tabs.some(t => t[0] === settingsTab)) settingsTab = 'account';
  root.innerHTML = `<div class="page"><div class="page-in">
    ${pageHead('Settings', 'Your account, security and how Switchboard looks.')}
    <div class="settings">
      <nav class="subnav" aria-label="Settings sections">${tabs.map(([id, label, ic]) =>
        `<button type="button" data-tab="${id}"${id === settingsTab ? ' aria-current="page"' : ''}>${icon(ic)}${label}</button>`).join('')}</nav>
      <div id="settings-body"></div>
    </div></div></div>`;
  root.querySelector('.subnav').addEventListener('click', ev => {
    const b = ev.target.closest('[data-tab]');
    if (!b) return;
    settingsTab = b.dataset.tab;
    root.querySelectorAll('.subnav button').forEach(x => {
      if (x === b) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
    });
    renderSettingsBody();
  });
  renderSettingsBody();
}

async function renderSettingsBody() {
  const body = $('#settings-body', shell);
  if (!body) return;
  const u = state.user;
  const bind = (sel, fn) => { const b = body.querySelector(sel); if (b) b.addEventListener('click', fn); };

  if (settingsTab === 'account') {
    body.innerHTML = panel(
      settingRow('Signed in as', 'Your name on this Switchboard.', `${tag(u.role === 'admin' ? 'Admin' : 'Member', u.role === 'admin' ? 'acc' : '')}<strong>${esc(u.username)}</strong>`) +
      settingRow('Password', 'Changing it keeps your vault and everything saved in it readable.', button('Change password', { attrs: 'id="pw"' })) +
      settingRow('Sessions', 'Ends your sessions on every device, including this one.', button('Sign out everywhere', { attrs: 'id="all"' })));
    bind('#pw', changePasswordDialog);
    bind('#all', signOutEverywhere);
  } else if (settingsTab === 'security') {
    const left = u.backup_codes_left;
    body.innerHTML = panel(u.totp_enabled
      ? settingRow('Two-factor authentication', `On. ${left} backup code${left === 1 ? '' : 's'} left.`,
        button('New backup codes', { attrs: 'id="codes"' }) + (state.require_2fa ? '' : button('Turn off', { kind: 'danger', attrs: 'id="off"' })))
      : settingRow('Two-factor authentication', 'Ask for a code from an authenticator app when you sign in.', button('Set up', { kind: 'primary', attrs: 'id="on"' })));
    bind('#on', twoFactorSetupDialog);
    bind('#codes', () => passwordDialog('New backup codes', 'Your old codes stop working once you make new ones.', 'Make new codes', async password => {
      const r = await api('POST', '/2fa/backup-codes', { password });
      await refresh();
      setTimeout(() => backupCodesDialog(r.backup_codes), 200);
    }));
    bind('#off', () => passwordDialog('Turn off two-factor', 'You will only need your password to sign in.', 'Turn off', async password => {
      await api('POST', '/2fa/disable', { password });
      toast('Two-factor turned off');
      await refresh();
    }));
  } else if (settingsTab === 'appearance') {
    const prefs = termPrefs();
    const fonts = [['Switchboard mono', DEFAULT_FONT], ['System monospace', 'ui-monospace, Menlo, Consolas, monospace'], ['Menlo', 'Menlo, monospace'], ['Consolas', 'Consolas, monospace'], ['Courier New', '"Courier New", monospace']];
    body.innerHTML = panel(
      settingRow('Theme', 'Follows your system unless you choose one.', segmented('Theme', [['system', 'System', 'device-laptop'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], themeChoice(), 'data-theme')) +
      settingRow('Terminal font', 'Saved in this browser. Colours are set per host.', `
        <select id="font" aria-label="Terminal font">${fonts.map(f => `<option value='${esc(f[1])}'${f[1] === prefs.font ? ' selected' : ''}>${esc(f[0])}</option>`).join('')}</select>
        <input id="size" type="number" min="10" max="28" value="${esc(prefs.size)}" aria-label="Font size" class="narrow">`));
    body.querySelector('.seg').addEventListener('click', ev => {
      const b = ev.target.closest('[data-theme]');
      if (!b) return;
      setThemeChoice(b.dataset.theme);
      body.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    });
    const save = () => saveTermPrefs({ font: $('#font', body).value, size: Math.min(28, Math.max(10, Number($('#size', body).value) || 14)) });
    $('#font', body).addEventListener('change', save);
    $('#size', body).addEventListener('change', save);
  } else if (settingsTab === 'users') {
    body.innerHTML = '<p class="muted">Loading\u2026</p>';
    let users;
    try { users = await api('GET', '/admin/users'); } catch (e) { body.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (settingsTab !== 'users') return;
    const rows = users.map(x => itemRow({
      lead: avatar(x.username),
      title: `${esc(x.username)}${x.id === u.id ? ' <span class="faint">(you)</span>' : ''}`,
      tags: `${tag(x.role === 'admin' ? 'Admin' : 'Member', x.role === 'admin' ? 'acc' : '')}${x.totp_enabled ? tag('2FA on') : ''}${x.must_change ? tag('Temporary password', 'warn') : ''}`,
      actions: (x.totp_enabled ? iconButton('shield-lock', `Reset two-factor for ${x.username}`, `data-reset="${esc(x.id)}" data-name="${esc(x.username)}"`) : '') +
        (x.id === u.id ? '' : iconButton('trash', `Delete ${x.username}`, `data-del="${esc(x.id)}" data-name="${esc(x.username)}"`)),
    })).join('');
    body.innerHTML = `<div class="stack">
      ${sectionHead('People', button('Add user', { kind: 'primary', icon: 'plus', attrs: 'id="add"' }))}
      ${panel(rows)}
      ${panel(settingRow('Require two-factor authentication', 'Everyone must set it up the next time they sign in.', switchControl({ id: 'req2fa', checked: state.require_2fa, label: 'Require two-factor authentication' })))}
    </div>`;
    bind('#add', addUserDialog);
    body.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () =>
      confirmDialog('Reset two-factor?', `${b.dataset.name} will be signed out and can set it up again.`, 'Reset', async () => {
        await api('POST', `/admin/users/${b.dataset.reset}/reset-2fa`);
        toast('Two-factor reset');
        renderSettingsBody();
      }, false)));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () =>
      confirmDialog(`Delete ${b.dataset.name}?`, 'Their account is removed, and their vault and everything saved in it is destroyed. This cannot be undone.', 'Delete user', async () => {
        await api('DELETE', '/admin/users/' + b.dataset.del);
        toast('User deleted');
        renderSettingsBody();
      })));
    $('#req2fa', body).addEventListener('change', async ev => {
      try { await api('POST', '/admin/require-2fa', { enabled: ev.target.checked }); state.require_2fa = ev.target.checked; toast(ev.target.checked ? 'Two-factor is now required' : 'Two-factor is optional'); }
      catch (e) { ev.target.checked = !ev.target.checked; toast(e.message, 'err'); }
    });
  } else if (settingsTab === 'server') {
    body.innerHTML = `<div class="stack">
      ${state.key_backup_pending ? notice('alert-triangle', '<strong>Back up the master key.</strong><div class="muted">If it is lost, no vault can be opened. Download a copy and keep it away from this server.</div>') : ''}
      ${panel(
        settingRow('Master key', 'Generated when Switchboard first started. Every stored secret is encrypted with it.', button('Download key', { kind: 'primary', icon: 'download', attrs: 'id="key"' })) +
        settingRow('Backup confirmed', 'Turn this on once the key is stored safely. It clears the reminder.', switchControl({ id: 'keydone', checked: !state.key_backup_pending, disabled: !state.key_backup_pending, label: 'Backup confirmed' })))}
      <div id="ts"></div>
    </div>`;
    bind('#key', () => passwordDialog('Download the master key', 'Enter your password to download it.', 'Download', async password => {
      const r = await api('POST', '/admin/master-key', { password });
      const url = URL.createObjectURL(new Blob([r.master_key + '\n'], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'switchboard-master.key' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Master key downloaded');
    }));
    $('#keydone', body).addEventListener('change', async ev => {
      if (!ev.target.checked) return;
      await api('POST', '/admin/key-backup-confirmed');
      state.key_backup_pending = false;
      updateNav();
      renderSettingsBody();
      toast('Marked as backed up');
    });
    renderTailscale($('#ts', body));
  }
}

/* ---------- start ---------- */

refresh().catch(() => { app.innerHTML = authPage('<div><h1>Can’t reach the server</h1><p class="sub">Check that Switchboard is running, then reload this page.</p></div>'); });

// Lets browsers install the app and keeps its files available briefly offline.
// Browsers only offer this over HTTPS or on localhost.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

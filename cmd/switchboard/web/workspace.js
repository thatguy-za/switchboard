'use strict';

/* Hosts, identities and SSH terminals. Depends on globals from app.js: api, esc, refresh, showView. */

const THEMES = {
  dark: { background: '#151514', foreground: '#e2e0d8', cursor: '#e2e0d8', selectionBackground: '#3d4a44' },
  light: { background: '#fbfaf7', foreground: '#1d1d1b', cursor: '#1d1d1b', selectionBackground: '#c9d6cf' },
  contrast: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#555555' },
};
const DEFAULT_FONT = 'ui-monospace, Menlo, Consolas, monospace';

const WS = {
  folders: [], hosts: [], identities: [], tabs: [], active: null, ctrl: false,
  term: null, ids: null, observer: null, keyHandler: null, nextTab: 1,
};

function themeFor(name) {
  if (name === 'auto') name = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return THEMES[name] || THEMES.dark;
}

function termPrefs() {
  try { return Object.assign({ font: DEFAULT_FONT, size: 14 }, JSON.parse(localStorage.getItem('sb_term') || '{}')); }
  catch (e) { return { font: DEFAULT_FONT, size: 14 }; }
}

function saveTermPrefs(p) {
  try { localStorage.setItem('sb_term', JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
  for (const t of WS.tabs) {
    t.term.options.fontFamily = p.font;
    t.term.options.fontSize = p.size;
  }
  fitActive();
}

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('sb_collapsed') || '[]')); } catch (e) { return new Set(); }
}
const collapsed = loadCollapsed();
function saveCollapsed() {
  try { localStorage.setItem('sb_collapsed', JSON.stringify([...collapsed])); } catch (e) { /* ignore */ }
}

const byName = (a, b) => a.name.localeCompare(b.name);
const $q = (root, sel) => root.querySelector(sel);

/* ---------- dialogs ---------- */

// Opens a modal form. onSubmit gets the FormData and the dialog; throwing keeps it open and shows the message.
function dialog(title, body, { onSubmit, submitLabel = 'Save', extra = '', hideCancel = false } = {}) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form class="dlg"><h1>${esc(title)}</h1>${body}<p class="err"></p>
    <div class="actions">${onSubmit ? `<button class="primary">${esc(submitLabel)}</button>` : ''}${extra}
    ${hideCancel ? '' : `<button type="button" data-cancel>${onSubmit ? 'Cancel' : 'Close'}</button>`}</div></form>`;
  document.body.appendChild(d);
  const form = d.querySelector('form');
  d.addEventListener('close', () => d.remove());
  d.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => d.close()));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const err = form.querySelector('.err');
    const btn = form.querySelector('button.primary');
    err.textContent = '';
    if (btn) btn.disabled = true;
    try {
      if (onSubmit) await onSubmit(new FormData(form), d);
      d.close();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  d.showModal();
  const first = d.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return d;
}

function copyText(text, btn) {
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1200); }
}

/* ---------- data ---------- */

async function loadHosts() {
  const r = await api('GET', '/hosts');
  WS.folders = r.folders;
  WS.hosts = r.hosts;
  renderTree();
}

async function loadIdentities() {
  WS.identities = await api('GET', '/identities');
  renderIdentities();
}

function folderPath(id) {
  const parts = [];
  for (let n = 0; id && n < 64; n++) {
    const f = WS.folders.find(x => x.id === id);
    if (!f) break;
    parts.unshift(f.name);
    id = f.parent_id;
  }
  return parts.join(' / ');
}

function descendants(id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of WS.folders) if (out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

function folderOptions(selected, excludeId) {
  const skip = excludeId ? descendants(excludeId) : new Set();
  let out = `<option value="">Top level</option>`;
  const walk = (parent, depth) => {
    for (const f of WS.folders.filter(x => x.parent_id === parent).sort(byName)) {
      if (skip.has(f.id)) continue;
      out += `<option value="${esc(f.id)}"${f.id === selected ? ' selected' : ''}>${'  '.repeat(depth)}${esc(f.name)}</option>`;
      walk(f.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/* ---------- host tree ---------- */

function renderTree() {
  const tree = $q(WS.term, '#tree');
  const q = $q(WS.term, '#q').value.trim().toLowerCase();
  const hostRow = (h, depth, hint) => `
    <div class="row host d${Math.min(depth, 6)}" tabindex="0" data-host="${esc(h.id)}">
      <span class="name">${esc(h.name)}</span>
      <span class="muted addr">${esc(hint || (h.username ? h.username + '@' : '') + h.address)}</span>
      <button class="mini" data-edit-host="${esc(h.id)}" aria-label="Edit ${esc(h.name)}">Edit</button>
    </div>`;

  if (q) {
    const hits = WS.hosts.filter(h => `${h.name} ${h.address} ${h.username} ${folderPath(h.folder_id)}`.toLowerCase().includes(q));
    tree.innerHTML = hits.length
      ? hits.sort(byName).map(h => hostRow(h, 0, [folderPath(h.folder_id), h.address].filter(Boolean).join(' · '))).join('')
      : '<p class="muted pad">No matching hosts.</p>';
    return;
  }
  if (!WS.hosts.length && !WS.folders.length) {
    tree.innerHTML = '<p class="muted pad">No hosts yet. Add one to get started.</p>';
    return;
  }
  const walk = (parent, depth) => {
    let out = '';
    for (const f of WS.folders.filter(x => x.parent_id === parent).sort(byName)) {
      const open = !collapsed.has(f.id);
      out += `<div class="row folder d${Math.min(depth, 6)}" tabindex="0" data-folder="${esc(f.id)}" aria-expanded="${open}">
        <span class="caret">${open ? '▾' : '▸'}</span><span class="name">${esc(f.name)}</span>
        <button class="mini" data-edit-folder="${esc(f.id)}" aria-label="Edit folder ${esc(f.name)}">Edit</button></div>`;
      if (open) out += walk(f.id, depth + 1);
    }
    for (const h of WS.hosts.filter(x => x.folder_id === parent).sort(byName)) out += hostRow(h, depth);
    return out;
  };
  tree.innerHTML = walk('', 0);
}

function bindTree() {
  const tree = $q(WS.term, '#tree');
  tree.addEventListener('click', ev => {
    const edit = ev.target.closest('[data-edit-host]');
    if (edit) return hostDialog(WS.hosts.find(h => h.id === edit.dataset.editHost));
    const editF = ev.target.closest('[data-edit-folder]');
    if (editF) return folderDialog(WS.folders.find(f => f.id === editF.dataset.editFolder));
    const row = ev.target.closest('[data-host]');
    if (row) return openHost(WS.hosts.find(h => h.id === row.dataset.host));
    const fold = ev.target.closest('[data-folder]');
    if (fold) {
      const id = fold.dataset.folder;
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      saveCollapsed();
      renderTree();
    }
  });
  tree.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.target.closest('button')) return;
    const row = ev.target.closest('.row');
    if (row) row.click();
  });
}

/* ---------- host and folder dialogs ---------- */

function hostDialog(host) {
  const h = host || { name: '', folder_id: '', address: '', port: 22, username: '', auth: 'password', identity_id: '', has_password: false, theme: 'auto' };
  const idOpts = WS.identities.length
    ? WS.identities.map(i => `<option value="${esc(i.id)}"${i.id === h.identity_id ? ' selected' : ''}>${esc(i.name)}</option>`).join('')
    : '<option value="">No identities yet</option>';
  const themeOpts = ['auto', 'dark', 'light', 'contrast']
    .map(t => `<option value="${t}"${t === h.theme ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('');
  const d = dialog(host ? 'Edit host' : 'New host', `
    <label>Name<input type="text" name="name" value="${esc(h.name)}" required maxlength="80"></label>
    <label>Folder<select name="folder_id">${folderOptions(h.folder_id)}</select></label>
    <div class="inline">
      <label>Address<input type="text" name="address" value="${esc(h.address)}" required autocapitalize="off" spellcheck="false"></label>
      <label class="narrow">Port<input type="number" name="port" value="${esc(h.port)}" min="1" max="65535" required></label>
    </div>
    <label>Username<input type="text" name="username" value="${esc(h.username)}" autocapitalize="off" spellcheck="false" autocomplete="off"></label>
    <label>Sign in with<select name="auth"><option value="password"${h.auth === 'password' ? ' selected' : ''}>Password</option>
      <option value="key"${h.auth === 'key' ? ' selected' : ''}>Identity (SSH key)</option></select></label>
    <label data-for="password">Password<input type="password" name="password" autocomplete="new-password"
      placeholder="${h.has_password ? 'Saved. Leave blank to keep it.' : ''}"></label>
    <label data-for="key">Identity<select name="identity_id">${idOpts}</select></label>
    <label>Terminal colours<select name="theme">${themeOpts}</select></label>`, {
    extra: host ? '<button type="button" class="danger" data-del>Delete</button>' : '',
    onSubmit: async fd => {
      const body = {
        name: fd.get('name'), folder_id: fd.get('folder_id'), address: fd.get('address'),
        port: Number(fd.get('port')), username: fd.get('username'), auth: fd.get('auth'),
        identity_id: fd.get('auth') === 'key' ? fd.get('identity_id') : '', theme: fd.get('theme'),
      };
      if (body.auth === 'key' && !body.identity_id) throw new Error('Choose an identity, or create one in the Identities tab.');
      if (body.auth === 'password' && (fd.get('password') || !host)) body.password = fd.get('password');
      await api(host ? 'PUT' : 'POST', host ? '/hosts/' + host.id : '/hosts', body);
      await Promise.all([loadHosts(), loadIdentities()]);
    },
  });
  const sync = () => {
    const auth = d.querySelector('[name=auth]').value;
    d.querySelectorAll('[data-for]').forEach(l => { l.hidden = l.dataset.for !== auth; });
  };
  d.querySelector('[name=auth]').addEventListener('change', sync);
  sync();
  const del = d.querySelector('[data-del]');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete ${host.name}?`)) return;
    try {
      await api('DELETE', '/hosts/' + host.id);
      WS.tabs.filter(t => t.host.id === host.id).forEach(closeTab);
      await loadHosts();
      d.close();
    } catch (e) { d.querySelector('.err').textContent = e.message; }
  });
}

function folderDialog(folder) {
  const d = dialog(folder ? 'Edit folder' : 'New folder', `
    <label>Name<input type="text" name="name" value="${esc(folder ? folder.name : '')}" required maxlength="80"></label>
    <label>Inside<select name="parent_id">${folderOptions(folder ? folder.parent_id : '', folder && folder.id)}</select></label>`, {
    extra: folder ? '<button type="button" class="danger" data-del>Delete</button>' : '',
    onSubmit: async fd => {
      const body = { name: fd.get('name'), parent_id: fd.get('parent_id') };
      await api(folder ? 'PUT' : 'POST', folder ? '/folders/' + folder.id : '/folders', body);
      await loadHosts();
    },
  });
  const del = d.querySelector('[data-del]');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete folder "${folder.name}" and any folders inside it? Hosts in them move to the top level.`)) return;
    try { await api('DELETE', '/folders/' + folder.id); await loadHosts(); d.close(); }
    catch (e) { d.querySelector('.err').textContent = e.message; }
  });
}

/* ---------- terminal tabs ---------- */

const encoder = new TextEncoder();

function sendCtl(tab, obj) {
  if (tab.sock && tab.sock.readyState === 1) tab.sock.send(JSON.stringify(obj));
}

function sendRaw(tab, text) {
  if (tab.state === 'live' && tab.sock && tab.sock.readyState === 1) tab.sock.send(encoder.encode(text));
}

function sendInput(tab, data) {
  if (WS.ctrl && data.length === 1) {
    const c = data.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
    setCtrl(false);
  }
  sendRaw(tab, data);
}

function setCtrl(on) {
  WS.ctrl = on;
  const b = WS.term && $q(WS.term, '[data-key=ctrl]');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
}

function showOverlay(tab, { title, text = '', tone = '', buttons = [] }) {
  const o = tab.overlay;
  o.hidden = false;
  o.innerHTML = `<div class="tbox ${tone}"><p><strong>${title}</strong></p>${text ? `<p>${text}</p>` : ''}<div class="actions"></div></div>`;
  const actions = o.querySelector('.actions');
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.cls) el.className = b.cls;
    el.addEventListener('click', b.fn);
    actions.appendChild(el);
  }
  const first = actions.querySelector('button');
  if (first && WS.active === tab) first.focus();
}

function hideOverlay(tab) { tab.overlay.hidden = true; tab.overlay.innerHTML = ''; }

function closeButton(tab) { return { label: 'Close tab', fn: () => closeTab(tab) }; }

function connect(tab) {
  clearTimeout(tab.timer);
  tab.state = 'connecting';
  renderTabs();
  showOverlay(tab, { title: 'Connecting…' });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/api/ws/ssh/${encodeURIComponent(tab.host.id)}`);
  sock.binaryType = 'arraybuffer';
  tab.sock = sock;
  sock.onopen = () => sendCtl(tab, { type: 'resize', cols: tab.term.cols, rows: tab.term.rows });
  sock.onmessage = ev => {
    if (tab.sock !== sock) return;
    if (typeof ev.data !== 'string') { tab.term.write(new Uint8Array(ev.data)); return; }
    onControl(tab, JSON.parse(ev.data));
  };
  sock.onclose = ev => { if (tab.sock === sock && !tab.closed) onClosed(tab, ev); };
}

function setState(tab, state) { tab.state = state; renderTabs(); }

function onControl(tab, m) {
  const retry = { label: 'Retry', cls: 'primary', fn: () => { tab.retries = 0; connect(tab); } };
  switch (m.type) {
    case 'status':
      break;
    case 'hostkey': {
      setState(tab, 'hostkey');
      const name = esc(tab.host.name);
      const answer = accept => () => { sendCtl(tab, { type: 'trust', accept }); showOverlay(tab, { title: 'Connecting…' }); };
      if (m.changed) {
        showOverlay(tab, {
          tone: 'danger', title: `Warning: the host key for ${name} has changed`,
          text: `Someone may be intercepting this connection, or the server was reinstalled. Only continue if you know why.<br>
            Saved: <code>${esc(m.old_fingerprint)}</code><br>Now: <code>${esc(m.fingerprint)}</code> (${esc(m.key_type)})`,
          buttons: [{ label: 'Disconnect', cls: 'primary', fn: answer(false) }, { label: 'Accept new key', cls: 'danger', fn: answer(true) }],
        });
      } else {
        showOverlay(tab, {
          title: `First connection to ${name}`,
          text: `The server's host key fingerprint is <code>${esc(m.fingerprint)}</code> (${esc(m.key_type)}). Continue only if this is the server you expect.`,
          buttons: [{ label: 'Trust and connect', cls: 'primary', fn: answer(true) }, { label: 'Cancel', fn: answer(false) }],
        });
      }
      break;
    }
    case 'connected':
      if (tab.connectedBefore) tab.term.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n');
      tab.connectedBefore = true;
      tab.retries = 0;
      hideOverlay(tab);
      setState(tab, 'live');
      sendCtl(tab, { type: 'resize', cols: tab.term.cols, rows: tab.term.rows });
      if (WS.active === tab) tab.term.focus();
      break;
    case 'error':
      if (m.retry && tab.connectedBefore && tab.retries < 8) { scheduleReconnect(tab); break; }
      setState(tab, 'fatal');
      showOverlay(tab, { tone: 'danger', title: esc(m.message), buttons: [retry, closeButton(tab)] });
      break;
    case 'closed':
      setState(tab, 'ended');
      showOverlay(tab, { title: 'Session ended', buttons: [{ label: 'Reconnect', cls: 'primary', fn: () => connect(tab) }, closeButton(tab)] });
      break;
    default:
      break;
  }
}

function scheduleReconnect(tab) {
  const delay = Math.min(1000 * 2 ** tab.retries, 15000);
  tab.retries += 1;
  setState(tab, 'lost');
  showOverlay(tab, {
    title: 'Connection lost. Reconnecting\u2026',
    buttons: [{ label: 'Retry now', cls: 'primary', fn: () => { tab.retries = 0; connect(tab); } }, closeButton(tab)],
  });
  clearTimeout(tab.timer);
  tab.timer = setTimeout(() => connect(tab), delay);
}

function onClosed(tab, ev) {
  if (tab.state === 'fatal' || tab.state === 'ended' || tab.state === 'lost') return;
  if (ev.code === 4401) {
    setState(tab, 'fatal');
    showOverlay(tab, { tone: 'danger', title: 'Your web session has ended' });
    refresh();
    return;
  }
  const manual = { label: 'Retry now', cls: 'primary', fn: () => { tab.retries = 0; connect(tab); } };
  if (!tab.connectedBefore || tab.retries >= 8) {
    setState(tab, 'fatal');
    showOverlay(tab, { tone: 'danger', title: tab.connectedBefore ? 'Connection lost' : 'Could not connect', buttons: [manual, closeButton(tab)] });
    return;
  }
  scheduleReconnect(tab);
}

function openHost(host) {
  if (!host) return;
  const prefs = termPrefs();
  const pane = document.createElement('div');
  pane.className = 'pane';
  const holder = document.createElement('div');
  holder.className = 'term';
  const overlay = document.createElement('div');
  overlay.className = 'tover';
  overlay.hidden = true;
  pane.append(holder, overlay);
  $q(WS.term, '#panes').appendChild(pane);

  const term = new Terminal({
    fontFamily: prefs.font, fontSize: prefs.size, cursorBlink: true, scrollback: 5000,
    theme: themeFor(host.theme),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const tab = { id: WS.nextTab++, host, term, fit, pane, overlay, sock: null, state: 'connecting', retries: 0, timer: null, closed: false, connectedBefore: false };
  WS.tabs.push(tab);
  showView('terminals');
  activate(tab);
  term.open(holder);
  fitTab(tab);
  term.onData(d => sendInput(tab, d));
  term.onBinary(d => { if (tab.state === 'live' && tab.sock.readyState === 1) tab.sock.send(Uint8Array.from(d, c => c.charCodeAt(0))); });
  term.onResize(({ cols, rows }) => sendCtl(tab, { type: 'resize', cols, rows }));
  connect(tab);
}

function fitTab(tab) {
  try { if (tab.pane.offsetParent !== null) tab.fit.fit(); } catch (e) { /* not laid out yet */ }
}

function fitActive() { if (WS.active) fitTab(WS.active); }

function activate(tab) {
  WS.active = tab;
  for (const t of WS.tabs) t.pane.hidden = t !== tab;
  $q(WS.term, '#empty').hidden = !!tab;
  $q(WS.term, '#side').classList.remove('open');
  renderTabs();
  requestAnimationFrame(() => { if (tab) { fitTab(tab); tab.term.focus(); } });
}

function closeTab(tab) {
  tab.closed = true;
  clearTimeout(tab.timer);
  try { if (tab.sock) tab.sock.close(); } catch (e) { /* already closed */ }
  tab.term.dispose();
  tab.pane.remove();
  const i = WS.tabs.indexOf(tab);
  WS.tabs.splice(i, 1);
  if (WS.active === tab) activate(WS.tabs[Math.min(i, WS.tabs.length - 1)] || null);
  else renderTabs();
}

function renderTabs() {
  if (!WS.term) return;
  $q(WS.term, '#tabs').innerHTML = WS.tabs.map(t => `
    <div class="tab${t === WS.active ? ' on' : ''}">
      <button class="tab-name" data-tab="${t.id}" role="tab" aria-selected="${t === WS.active}">
        <span class="dot ${t.state}"></span>${esc(t.host.name)}</button>
      <button class="tab-x" data-close="${t.id}" aria-label="Close ${esc(t.host.name)}">×</button>
    </div>`).join('');
}

/* ---------- identities ---------- */

function renderIdentities() {
  if (!WS.ids) return;
  const rows = WS.identities.map(i => `
    <tr><td>${esc(i.name)}<div class="muted small">${esc(i.comment)}</div></td>
      <td>${i.kind === 'rsa' ? 'RSA-4096' : 'Ed25519'}</td>
      <td class="mono small">${esc(i.fingerprint)}</td>
      <td class="small">${i.hosts.length ? esc(i.hosts.join(', ')) : '<span class="muted">No hosts</span>'}</td>
      <td class="r"><button data-pub="${esc(i.id)}">Copy public key</button>
        <button data-export="${esc(i.id)}">Export</button>
        <button class="danger" data-delid="${esc(i.id)}">Delete</button></td></tr>`).join('');
  WS.ids.innerHTML = `<main><section><h2>Identities</h2>
    <p class="muted">SSH key pairs. Private keys are encrypted in your vault and never sent to the browser unless you export one.</p>
    ${WS.identities.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Fingerprint</th><th>Used by</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<p class="muted">No identities yet.</p>'}
    <div class="actions"><button class="primary" id="id-new">New identity</button><button id="id-import">Import key</button></div>
  </section></main>`;
}

function identityDefaults() {
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return { name: `Key ${ym}`, comment: `${state.user.username}@switchboard-${ym}` };
}

function newIdentityDialog() {
  const def = identityDefaults();
  dialog('New identity', `
    <label>Name<input type="text" name="name" value="${esc(def.name)}" required maxlength="80"></label>
    <label>Comment<input type="text" name="comment" value="${esc(def.comment)}" maxlength="120"></label>
    <label>Type<select name="kind"><option value="ed25519">Ed25519 (recommended)</option><option value="rsa">RSA-4096 (slow to generate)</option></select></label>`, {
    submitLabel: 'Generate',
    onSubmit: async fd => {
      await api('POST', '/identities/generate', { name: fd.get('name'), comment: fd.get('comment'), kind: fd.get('kind') });
      await loadIdentities();
    },
  });
}

function importIdentityDialog() {
  dialog('Import key', `
    <label>Name<input type="text" name="name" required maxlength="80"></label>
    <label>Private key<textarea name="private_key" rows="6" required spellcheck="false" autocomplete="off"
      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
    <label>Passphrase, if the key has one<input type="password" name="passphrase" autocomplete="off"></label>`, {
    submitLabel: 'Import',
    onSubmit: async fd => {
      try {
        await api('POST', '/identities/import', { name: fd.get('name'), private_key: fd.get('private_key'), passphrase: fd.get('passphrase') });
      } catch (e) {
        const text = { passphrase_required: 'This key is passphrase-protected. Enter its passphrase.', invalid_key: 'That is not a readable private key, or the passphrase is wrong.', unsupported_key: 'Only Ed25519 and RSA keys are supported.' }[e.code];
        throw text ? new Error(text) : e;
      }
      await loadIdentities();
    },
  });
}

function exportIdentityDialog(id) {
  dialog('Export private key', `
    <p>Anyone with this key can sign in to every host that trusts it. Only export it if you need it elsewhere.</p>
    <label>Your password<input type="password" name="password" required autocomplete="current-password"></label>`, {
    submitLabel: 'Show key',
    onSubmit: async fd => {
      const r = await api('POST', `/identities/${id}/export`, { password: fd.get('password') });
      const view = dialog('Private key', `<textarea readonly rows="8" class="mono small" spellcheck="false">${esc(r.private_key)}</textarea>`, {
        extra: '<button type="button" data-copy>Copy</button>',
      });
      view.querySelector('[data-copy]').addEventListener('click', ev => copyText(r.private_key, ev.target));
      view.addEventListener('close', () => { view.querySelector('textarea') && (view.querySelector('textarea').value = ''); });
    },
  });
}

function bindIdentities() {
  WS.ids.addEventListener('click', async ev => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.id === 'id-new') return newIdentityDialog();
    if (t.id === 'id-import') return importIdentityDialog();
    if (t.dataset.pub) return copyText(WS.identities.find(i => i.id === t.dataset.pub).public_key, t);
    if (t.dataset.export) return exportIdentityDialog(t.dataset.export);
    if (t.dataset.delid) {
      const i = WS.identities.find(x => x.id === t.dataset.delid);
      const used = i.hosts.length ? ` ${i.hosts.length} host${i.hosts.length === 1 ? ' uses' : 's use'} it and will need another way to sign in.` : '';
      if (!confirm(`Delete identity "${i.name}"? The private key is destroyed.${used}`)) return;
      try { await api('DELETE', '/identities/' + i.id); await Promise.all([loadIdentities(), loadHosts()]); } catch (e) { alert(e.message); }
    }
  });
}

/* ---------- mount ---------- */

function mountWorkspace(termRoot, idRoot) {
  WS.term = termRoot;
  WS.ids = idRoot;
  termRoot.innerHTML = `
    <div class="ws">
      <aside class="side" id="side">
        <div class="side-top"><input type="search" id="q" placeholder="Search hosts (Ctrl+K)" autocomplete="off" aria-label="Search hosts"></div>
        <div class="tree" id="tree"></div>
        <div class="side-bottom"><button class="primary" id="add-host">New host</button><button id="add-folder">New folder</button></div>
      </aside>
      <div class="termarea">
        <div class="tabbar"><button class="sidetoggle" id="side-toggle">Hosts</button><div class="tabs" id="tabs" role="tablist"></div></div>
        <div class="panes" id="panes"><p class="empty muted" id="empty">Pick a host to open a terminal.</p></div>
        <div class="keybar" id="keybar" aria-label="Terminal keys">
          <button data-key="esc">Esc</button><button data-key="ctrl" aria-pressed="false">Ctrl</button><button data-key="tab">Tab</button>
          <button data-key="left" aria-label="Left">←</button><button data-key="down" aria-label="Down">↓</button>
          <button data-key="up" aria-label="Up">↑</button><button data-key="right" aria-label="Right">→</button>
        </div>
      </div>
    </div>`;
  bindTree();
  bindIdentities();

  const q = $q(termRoot, '#q');
  q.addEventListener('input', renderTree);
  q.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { q.value = ''; renderTree(); q.blur(); if (WS.active) WS.active.term.focus(); }
    if (ev.key === 'Enter') {
      const first = $q(termRoot, '#tree [data-host]');
      if (first) { first.click(); q.value = ''; renderTree(); }
    }
  });
  $q(termRoot, '#add-host').addEventListener('click', () => hostDialog(null));
  $q(termRoot, '#add-folder').addEventListener('click', () => folderDialog(null));
  $q(termRoot, '#side-toggle').addEventListener('click', () => $q(termRoot, '#side').classList.toggle('open'));

  $q(termRoot, '#tabs').addEventListener('click', ev => {
    const close = ev.target.closest('[data-close]');
    if (close) return closeTab(WS.tabs.find(t => t.id === Number(close.dataset.close)));
    const tabBtn = ev.target.closest('[data-tab]');
    if (tabBtn) activate(WS.tabs.find(t => t.id === Number(tabBtn.dataset.tab)));
  });

  const keys = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
  const keybar = $q(termRoot, '#keybar');
  keybar.addEventListener('mousedown', ev => ev.preventDefault());
  keybar.addEventListener('click', ev => {
    const b = ev.target.closest('[data-key]');
    if (!b) return;
    if (b.dataset.key === 'ctrl') return setCtrl(!WS.ctrl);
    if (WS.active) { sendRaw(WS.active, keys[b.dataset.key]); WS.active.term.focus(); }
  });

  WS.observer = new ResizeObserver(() => requestAnimationFrame(fitActive));
  WS.observer.observe($q(termRoot, '#panes'));

  WS.keyHandler = ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      showView('terminals');
      $q(termRoot, '#side').classList.add('open');
      q.focus();
      q.select();
    }
  };
  document.addEventListener('keydown', WS.keyHandler);

  loadIdentities().then(loadHosts).catch(() => {});
}

function destroyWorkspace() {
  for (const t of [...WS.tabs]) closeTab(t);
  if (WS.observer) WS.observer.disconnect();
  if (WS.keyHandler) document.removeEventListener('keydown', WS.keyHandler);
  Object.assign(WS, { folders: [], hosts: [], identities: [], tabs: [], active: null, ctrl: false, term: null, ids: null, observer: null, keyHandler: null });
}

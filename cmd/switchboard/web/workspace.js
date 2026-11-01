'use strict';

/* Hosts, identities and SSH terminals. Depends on globals from app.js: api, esc, refresh, showView. */

const THEMES = {
  dark: { background: '#151514', foreground: '#e2e0d8', cursor: '#e2e0d8', selectionBackground: '#3d4a44' },
  light: { background: '#fbfaf7', foreground: '#1d1d1b', cursor: '#1d1d1b', selectionBackground: '#c9d6cf' },
  contrast: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#555555' },
};
const DEFAULT_FONT = 'ui-monospace, Menlo, Consolas, monospace';

// A workspace tab holds a tree of panes; each pane is one SSH session with its own terminal.
//   node = { kind: 'leaf', sess } | { kind: 'split', dir: 'row' | 'col', ratio, a: node, b: node }
const WS = {
  folders: [], hosts: [], identities: [], tabs: [], active: null, ctrl: false,
  term: null, ids: null, keyHandler: null, nextTab: 1,
};
const MAX_PANES = 6;

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
  for (const sess of allSessions()) {
    sess.term.options.fontFamily = p.font;
    sess.term.options.fontSize = p.size;
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
  const h = host || { name: '', folder_id: '', address: '', port: 22, username: '', auth: 'password', identity_id: '', has_password: false, theme: 'auto', jumps: [], forwards: [] };
  const jumps = [...h.jumps];
  const fwds = h.forwards.map(f => ({ ...f }));
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
    <label>Terminal colours<select name="theme">${themeOpts}</select></label>
    <details id="jsec"${jumps.length ? ' open' : ''}><summary>Jump hosts</summary>
      <p class="muted small">Connect through these hosts first, in order. Each one signs in with its own saved credentials.</p>
      <div id="jlist"></div>
      <div class="inline"><label>Add a hop<select id="jadd"></select></label><button type="button" id="jbtn">Add</button></div>
    </details>
    <details id="fsec"${fwds.length ? ' open' : ''}><summary>Port forwards</summary>
      <p class="muted small"><strong>Local:</strong> Switchboard listens on the port and reaches the destination through this host.
        <strong>Remote:</strong> this host listens on its loopback port and reaches the destination from Switchboard.
        Forwards last while a terminal for this host is open. A local forward is reachable only on ports you publish for the Switchboard container.</p>
      <div id="flist"></div><button type="button" id="fadd">Add forward</button>
    </details>`, {
    extra: host ? '<button type="button" class="danger" data-del>Delete</button>' : '',
    onSubmit: async fd => {
      const body = {
        name: fd.get('name'), folder_id: fd.get('folder_id'), address: fd.get('address'),
        port: Number(fd.get('port')), username: fd.get('username'), auth: fd.get('auth'),
        identity_id: fd.get('auth') === 'key' ? fd.get('identity_id') : '', theme: fd.get('theme'),
        jumps,
        forwards: fwds.map(f => ({ kind: f.kind, bind_port: Number(f.bind_port), dest_host: String(f.dest_host || '').trim(), dest_port: Number(f.dest_port) })),
      };
      if (body.auth === 'key' && !body.identity_id) throw new Error('Choose an identity, or create one in the Identities tab.');
      if (body.auth === 'password' && (fd.get('password') || !host)) body.password = fd.get('password');
      for (const f of body.forwards) {
        if (!f.bind_port || !f.dest_host || !f.dest_port) throw new Error('Fill in every port forward, or remove the empty ones.');
        if (f.kind === 'local' && f.bind_port < 1024) throw new Error('Local forwards need a port of 1024 or higher.');
      }
      await api(host ? 'PUT' : 'POST', host ? '/hosts/' + host.id : '/hosts', body);
      await Promise.all([loadHosts(), loadIdentities()]);
    },
  });
  d.classList.add('wide');

  const sync = () => {
    const auth = d.querySelector('[name=auth]').value;
    d.querySelectorAll('[data-for]').forEach(l => { l.hidden = l.dataset.for !== auth; });
  };
  d.querySelector('[name=auth]').addEventListener('change', sync);
  sync();

  const hostName = id => (WS.hosts.find(x => x.id === id) || { name: '(deleted host)' }).name;
  const drawJumps = () => {
    d.querySelector('#jlist').innerHTML = jumps.map((id, i) => `
      <div class="jrow"><span>${i + 1}. ${esc(hostName(id))}</span>
        <button type="button" data-up="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" data-down="${i}" aria-label="Move down"${i === jumps.length - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" data-rm="${i}">Remove</button></div>`).join('');
    const options = WS.hosts.filter(x => (!host || x.id !== host.id) && !jumps.includes(x.id)).sort(byName);
    d.querySelector('#jadd').innerHTML = options.length
      ? options.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') : '<option value="">No other hosts</option>';
    d.querySelector('#jbtn').disabled = !options.length || jumps.length >= 5;
  };
  d.querySelector('#jlist').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    const [k, i] = Object.entries(b.dataset)[0];
    const n = Number(i);
    if (k === 'rm') jumps.splice(n, 1);
    else if (k === 'up' && n > 0) [jumps[n - 1], jumps[n]] = [jumps[n], jumps[n - 1]];
    else if (k === 'down' && n < jumps.length - 1) [jumps[n + 1], jumps[n]] = [jumps[n], jumps[n + 1]];
    drawJumps();
  });
  d.querySelector('#jbtn').addEventListener('click', () => {
    const id = d.querySelector('#jadd').value;
    if (id) { jumps.push(id); drawJumps(); }
  });
  drawJumps();

  const drawFwds = () => {
    d.querySelector('#flist').innerHTML = fwds.map((f, i) => `
      <div class="frow" data-i="${i}">
        <select data-k="kind" aria-label="Type"><option value="local"${f.kind === 'local' ? ' selected' : ''}>Local</option>
          <option value="remote"${f.kind === 'remote' ? ' selected' : ''}>Remote</option></select>
        <input type="number" data-k="bind_port" min="1" max="65535" placeholder="Port" aria-label="Listen port" value="${esc(f.bind_port || '')}">
        <span class="muted">→</span>
        <input type="text" data-k="dest_host" placeholder="Host" aria-label="Destination host" value="${esc(f.dest_host || '')}" autocapitalize="off" spellcheck="false">
        <input type="number" data-k="dest_port" min="1" max="65535" placeholder="Port" aria-label="Destination port" value="${esc(f.dest_port || '')}">
        <button type="button" data-rm="${i}" aria-label="Remove forward">×</button></div>`).join('');
  };
  d.querySelector('#flist').addEventListener('input', ev => {
    const row = ev.target.closest('.frow');
    if (row && ev.target.dataset.k) fwds[Number(row.dataset.i)][ev.target.dataset.k] = ev.target.value;
  });
  d.querySelector('#flist').addEventListener('click', ev => {
    const b = ev.target.closest('[data-rm]');
    if (b) { fwds.splice(Number(b.dataset.rm), 1); drawFwds(); }
  });
  d.querySelector('#fadd').addEventListener('click', () => {
    fwds.push({ kind: 'local', bind_port: '', dest_host: 'localhost', dest_port: '' });
    drawFwds();
    const last = d.querySelector('#flist .frow:last-child [data-k=bind_port]');
    if (last) last.focus();
  });
  drawFwds();

  const del = d.querySelector('[data-del]');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete ${host.name}?`)) return;
    try {
      await api('DELETE', '/hosts/' + host.id);
      allSessions().filter(x => x.host.id === host.id).forEach(closeSession);
      await loadHosts();
      d.close();
    } catch (e) { d.querySelector('.err').textContent = e.message; }
  });
}

function pickHost(title, done) {
  const d = dialog(title, `<input type="search" name="q" placeholder="Search hosts" autocomplete="off" aria-label="Search hosts"><div class="picklist"></div>`);
  const q = d.querySelector('input');
  const list = d.querySelector('.picklist');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const hosts = WS.hosts.filter(h => !t || `${h.name} ${h.address} ${folderPath(h.folder_id)}`.toLowerCase().includes(t)).sort(byName);
    list.innerHTML = hosts.map(h => `<button type="button" class="pick" data-id="${esc(h.id)}">${esc(h.name)}
      <span class="muted">${esc((h.username ? h.username + '@' : '') + h.address)}</span></button>`).join('') || '<p class="muted">No matching hosts.</p>';
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const first = list.querySelector('.pick');
    if (first) first.click();
  });
  list.addEventListener('click', ev => {
    const b = ev.target.closest('.pick');
    if (!b) return;
    d.close();
    done(WS.hosts.find(h => h.id === b.dataset.id));
  });
  draw();
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

/* ---------- panes and sessions ---------- */

const encoder = new TextEncoder();
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

function leaves(node) { return node.kind === 'leaf' ? [node.sess] : [...leaves(node.a), ...leaves(node.b)]; }
function allSessions() { return WS.tabs.flatMap(t => leaves(t.root)); }

function findLeaf(node, sess) {
  if (node.kind === 'leaf') return node.sess === sess ? node : null;
  return findLeaf(node.a, sess) || findLeaf(node.b, sess);
}

function replaceNode(node, target, replacement) {
  if (node === target) return replacement;
  if (node.kind === 'split') {
    node.a = replaceNode(node.a, target, replacement);
    node.b = replaceNode(node.b, target, replacement);
  }
  return node;
}

// Returns the tree without sess, or null if it was the only pane.
function removeLeaf(node, sess) {
  if (node.kind === 'leaf') return node.sess === sess ? null : node;
  const a = removeLeaf(node.a, sess);
  const b = removeLeaf(node.b, sess);
  if (!a) return b;
  if (!b) return a;
  node.a = a;
  node.b = b;
  return node;
}

function sendCtl(sess, obj) {
  if (sess.sock && sess.sock.readyState === 1) sess.sock.send(JSON.stringify(obj));
}

function sendRaw(sess, text) {
  if (sess.state === 'live' && sess.sock && sess.sock.readyState === 1) sess.sock.send(encoder.encode(text));
}

function sendInput(sess, data) {
  if (WS.ctrl && data.length === 1) {
    const c = data.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
    setCtrl(false);
  }
  sendRaw(sess, data);
}

function setCtrl(on) {
  WS.ctrl = on;
  const b = WS.term && $q(WS.term, '[data-key=ctrl]');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
}

function showOverlay(sess, { title, text = '', tone = '', buttons = [] }) {
  const o = sess.overlay;
  o.hidden = false;
  o.innerHTML = `<div class="tbox ${tone}"><p><strong>${title}</strong></p>${text ? `<p>${text}</p>` : ''}<div class="actions"></div></div>`;
  const actions = o.querySelector('.actions');
  for (const b of buttons) {
    const e = document.createElement('button');
    e.textContent = b.label;
    if (b.cls) e.className = b.cls;
    e.addEventListener('click', b.fn);
    actions.appendChild(e);
  }
  const first = actions.querySelector('button');
  if (first && WS.active && WS.active.active === sess) first.focus();
}

function hideOverlay(sess) { sess.overlay.hidden = true; sess.overlay.innerHTML = ''; }
function closeButton(sess) { return { label: 'Close pane', fn: () => closeSession(sess) }; }

function setState(sess, state) {
  sess.state = state;
  updateHead(sess);
  renderTabs();
}

function forwardLabel(f) {
  return `${f.kind === 'remote' ? 'remote ' : ''}:${f.bind_port} → ${f.dest_host}:${f.dest_port}`;
}

function updateHead(sess) {
  const head = sess.head;
  head.querySelector('.dot').className = 'dot ' + sess.state;
  head.querySelector('.pname').textContent = sess.host.name;
  const rules = sess.host.forwards || [];
  const btn = head.querySelector('[data-act=fwd]');
  btn.hidden = !rules.length;
  const ok = rules.filter((_, i) => sess.fwd[i] && sess.fwd[i].ok).length;
  btn.textContent = `Forwards ${ok}/${rules.length}`;
  btn.classList.toggle('bad', rules.some((_, i) => sess.fwd[i] && !sess.fwd[i].ok));
  sess.fwdList.innerHTML = rules.map((f, i) => {
    const st = sess.fwd[i];
    const label = st ? (st.ok ? 'active' : esc(st.message || 'failed')) : (sess.state === 'live' ? 'starting' : 'not running');
    return `<div class="fline${st && !st.ok ? ' bad' : ''}"><code>${esc(forwardLabel(f))}</code><span class="muted">${label}</span></div>`;
  }).join('');
}

function newSession(host, wtab) {
  const prefs = termPrefs();
  const pane = el('div', 'pane');
  pane.innerHTML = `
    <div class="phead"><span class="dot"></span><span class="pname"></span><span class="grow"></span>
      <button type="button" class="pbtn" data-act="fwd" hidden></button>
      <button type="button" class="pbtn" data-act="split-row" title="Open another host beside this one">Split →</button>
      <button type="button" class="pbtn" data-act="split-col" title="Open another host below this one">Split ↓</button>
      <button type="button" class="pbtn" data-act="close" aria-label="Close pane">×</button></div>
    <div class="fwdlist" hidden></div>
    <div class="term"></div>
    <div class="tover" hidden></div>`;
  const term = new Terminal({
    fontFamily: prefs.font, fontSize: prefs.size, cursorBlink: true, scrollback: 5000,
    theme: themeFor(host.theme),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const sess = {
    host, wtab, term, fit, pane, head: pane.querySelector('.phead'), fwdList: pane.querySelector('.fwdlist'),
    holder: pane.querySelector('.term'), overlay: pane.querySelector('.tover'),
    sock: null, state: 'connecting', retries: 0, timer: null, closed: false, connectedBefore: false, opened: false, fwd: [],
  };
  sess.ro = new ResizeObserver(() => requestAnimationFrame(() => fitSess(sess)));
  sess.ro.observe(sess.holder);

  pane.addEventListener('pointerdown', () => focusSession(sess), true);
  pane.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') closeSession(sess);
    else if (b.dataset.act === 'fwd') sess.fwdList.hidden = !sess.fwdList.hidden;
    else splitSession(sess, b.dataset.act === 'split-row' ? 'row' : 'col');
  });
  updateHead(sess);
  return sess;
}

// The terminal can only be opened once its pane is in the page.
function ensureOpen(sess) {
  if (sess.opened) return;
  sess.opened = true;
  sess.term.open(sess.holder);
  sess.term.onData(d => sendInput(sess, d));
  sess.term.onBinary(d => { if (sess.state === 'live' && sess.sock.readyState === 1) sess.sock.send(Uint8Array.from(d, c => c.charCodeAt(0))); });
  sess.term.onResize(({ cols, rows }) => sendCtl(sess, { type: 'resize', cols, rows }));
}

function fitSess(sess) {
  try { if (sess.opened && !sess.closed && sess.holder.offsetParent !== null) sess.fit.fit(); } catch (e) { /* not laid out yet */ }
}

function fitActive() { if (WS.active) leaves(WS.active.root).forEach(fitSess); }

function focusSession(sess) {
  const wtab = sess.wtab;
  wtab.active = sess;
  for (const s of leaves(wtab.root)) s.pane.classList.toggle('on', s === sess && leaves(wtab.root).length > 1);
  renderTabs();
}

function connect(sess) {
  clearTimeout(sess.timer);
  sess.fwd = [];
  setState(sess, 'connecting');
  showOverlay(sess, { title: 'Connecting…' });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/api/ws/ssh/${encodeURIComponent(sess.host.id)}`);
  sock.binaryType = 'arraybuffer';
  sess.sock = sock;
  sock.onopen = () => sendCtl(sess, { type: 'resize', cols: sess.term.cols, rows: sess.term.rows });
  sock.onmessage = ev => {
    if (sess.sock !== sock) return;
    if (typeof ev.data !== 'string') { sess.term.write(new Uint8Array(ev.data)); return; }
    onControl(sess, JSON.parse(ev.data));
  };
  sock.onclose = ev => { if (sess.sock === sock && !sess.closed) onClosed(sess, ev); };
}

function onControl(sess, m) {
  const retry = { label: 'Retry', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } };
  switch (m.type) {
    case 'hostkey': {
      setState(sess, 'hostkey');
      const name = esc(m.host || sess.host.name);
      const hop = m.host && m.host !== sess.host.name ? `This is a jump host on the way to ${esc(sess.host.name)}. ` : '';
      const answer = accept => () => { sendCtl(sess, { type: 'trust', accept }); showOverlay(sess, { title: 'Connecting…' }); };
      if (m.changed) {
        showOverlay(sess, {
          tone: 'danger', title: `Warning: the host key for ${name} has changed`,
          text: `${hop}Someone may be intercepting this connection, or the server was reinstalled. Only continue if you know why.<br>
            Saved: <code>${esc(m.old_fingerprint)}</code><br>Now: <code>${esc(m.fingerprint)}</code> (${esc(m.key_type)})`,
          buttons: [{ label: 'Disconnect', cls: 'primary', fn: answer(false) }, { label: 'Accept new key', cls: 'danger', fn: answer(true) }],
        });
      } else {
        showOverlay(sess, {
          title: `First connection to ${name}`,
          text: `${hop}The server's host key fingerprint is <code>${esc(m.fingerprint)}</code> (${esc(m.key_type)}). Continue only if this is the server you expect.`,
          buttons: [{ label: 'Trust and connect', cls: 'primary', fn: answer(true) }, { label: 'Cancel', fn: answer(false) }],
        });
      }
      break;
    }
    case 'connected':
      if (sess.connectedBefore) sess.term.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n');
      sess.connectedBefore = true;
      sess.retries = 0;
      hideOverlay(sess);
      setState(sess, 'live');
      sendCtl(sess, { type: 'resize', cols: sess.term.cols, rows: sess.term.rows });
      if (WS.active && WS.active.active === sess) sess.term.focus();
      break;
    case 'forward':
      sess.fwd[m.forward.index] = m.forward;
      updateHead(sess);
      break;
    case 'error':
      if (m.retry && sess.connectedBefore && sess.retries < 8) { scheduleReconnect(sess); break; }
      setState(sess, 'fatal');
      showOverlay(sess, { tone: 'danger', title: esc(m.message), buttons: [retry, closeButton(sess)] });
      break;
    case 'closed':
      setState(sess, 'ended');
      showOverlay(sess, { title: 'Session ended', buttons: [{ label: 'Reconnect', cls: 'primary', fn: () => connect(sess) }, closeButton(sess)] });
      break;
    default:
      break;
  }
}

function scheduleReconnect(sess) {
  const delay = Math.min(1000 * 2 ** sess.retries, 15000);
  sess.retries += 1;
  setState(sess, 'lost');
  showOverlay(sess, {
    title: 'Connection lost. Reconnecting…',
    buttons: [{ label: 'Retry now', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } }, closeButton(sess)],
  });
  clearTimeout(sess.timer);
  sess.timer = setTimeout(() => connect(sess), delay);
}

function onClosed(sess, ev) {
  if (['fatal', 'ended', 'lost'].includes(sess.state)) return;
  if (ev.code === 4401) {
    setState(sess, 'fatal');
    showOverlay(sess, { tone: 'danger', title: 'Your web session has ended' });
    refresh();
    return;
  }
  const manual = { label: 'Retry now', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } };
  if (!sess.connectedBefore || sess.retries >= 8) {
    setState(sess, 'fatal');
    showOverlay(sess, { tone: 'danger', title: sess.connectedBefore ? 'Connection lost' : 'Could not connect', buttons: [manual, closeButton(sess)] });
    return;
  }
  scheduleReconnect(sess);
}

/* ---------- workspace tabs and layout ---------- */

function buildNode(node) {
  if (node.kind === 'leaf') {
    const cell = el('div', 'cell');
    cell.appendChild(node.sess.pane);
    return cell;
  }
  const box = el('div', 'split dir-' + node.dir);
  const a = buildNode(node.a);
  const b = buildNode(node.b);
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;
  const bar = el('div', 'divider dir-' + node.dir);
  bar.setAttribute('role', 'separator');
  bar.addEventListener('pointerdown', ev => dragDivider(ev, node, box, a, b));
  box.append(a, bar, b);
  return box;
}

function dragDivider(ev, node, box, a, b) {
  ev.preventDefault();
  const rect = box.getBoundingClientRect();
  const move = e => {
    const r = node.dir === 'row' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    node.ratio = Math.min(0.9, Math.max(0.1, r));
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); fitActive(); }, { once: true });
}

function renderLayout(wtab) {
  wtab.el.replaceChildren(buildNode(wtab.root));
  const all = leaves(wtab.root);
  all.forEach(ensureOpen);
  focusSession(wtab.active && all.includes(wtab.active) ? wtab.active : all[0]);
  requestAnimationFrame(() => all.forEach(fitSess));
}

function openHost(host) {
  if (!host) return;
  const wtab = { id: WS.nextTab++, root: null, active: null, el: el('div', 'layout') };
  const sess = newSession(host, wtab);
  wtab.root = { kind: 'leaf', sess };
  wtab.active = sess;
  WS.tabs.push(wtab);
  $q(WS.term, '#panes').appendChild(wtab.el);
  showView('terminals');
  activateTab(wtab);
  renderLayout(wtab);
  connect(sess);
}

function splitSession(sess, dir) {
  const wtab = sess.wtab;
  if (leaves(wtab.root).length >= MAX_PANES) { alert(`A tab holds at most ${MAX_PANES} panes.`); return; }
  pickHost(dir === 'row' ? 'Open beside this pane' : 'Open below this pane', host => {
    if (!host || sess.closed || !WS.tabs.includes(wtab)) return;
    const added = newSession(host, wtab);
    const leaf = findLeaf(wtab.root, sess);
    wtab.root = replaceNode(wtab.root, leaf, { kind: 'split', dir, ratio: 0.5, a: leaf, b: { kind: 'leaf', sess: added } });
    wtab.active = added;
    renderLayout(wtab);
    connect(added);
    added.term.focus();
  });
}

function teardown(sess) {
  sess.closed = true;
  clearTimeout(sess.timer);
  sess.ro.disconnect();
  try { if (sess.sock) sess.sock.close(); } catch (e) { /* already closed */ }
  sess.term.dispose();
  sess.pane.remove();
}

function closeSession(sess) {
  const wtab = sess.wtab;
  teardown(sess);
  wtab.root = removeLeaf(wtab.root, sess);
  if (!wtab.root) return closeTab(wtab);
  if (wtab.active === sess) wtab.active = leaves(wtab.root)[0];
  renderLayout(wtab);
  renderTabs();
  if (WS.active === wtab) wtab.active.term.focus();
}

function closeTab(wtab) {
  leaves(wtab.root).forEach(teardown);
  wtab.el.remove();
  const i = WS.tabs.indexOf(wtab);
  WS.tabs.splice(i, 1);
  if (WS.active === wtab) activateTab(WS.tabs[Math.min(i, WS.tabs.length - 1)] || null);
  else renderTabs();
}

function activateTab(wtab) {
  WS.active = wtab;
  for (const t of WS.tabs) t.el.hidden = t !== wtab;
  $q(WS.term, '#empty').hidden = !!wtab;
  $q(WS.term, '#side').classList.remove('open');
  renderTabs();
  requestAnimationFrame(() => { if (wtab) { fitActive(); wtab.active.term.focus(); } });
}

function renderTabs() {
  if (!WS.term) return;
  $q(WS.term, '#tabs').innerHTML = WS.tabs.map(t => {
    const n = leaves(t.root).length;
    const label = esc(t.active.host.name) + (n > 1 ? ` <span class="muted">+${n - 1}</span>` : '');
    return `<div class="tab${t === WS.active ? ' on' : ''}">
      <button class="tab-name" data-tab="${t.id}" role="tab" aria-selected="${t === WS.active}">
        <span class="dot ${t.active.state}"></span>${label}</button>
      <button class="tab-x" data-close="${t.id}" aria-label="Close tab">×</button>
    </div>`;
  }).join('');
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
    if (ev.key === 'Escape') { q.value = ''; renderTree(); q.blur(); if (WS.active) WS.active.active.term.focus(); }
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
    if (tabBtn) activateTab(WS.tabs.find(t => t.id === Number(tabBtn.dataset.tab)));
  });

  const keys = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
  const keybar = $q(termRoot, '#keybar');
  keybar.addEventListener('mousedown', ev => ev.preventDefault());
  keybar.addEventListener('click', ev => {
    const b = ev.target.closest('[data-key]');
    if (!b) return;
    if (b.dataset.key === 'ctrl') return setCtrl(!WS.ctrl);
    const sess = WS.active && WS.active.active;
    if (sess) { sendRaw(sess, keys[b.dataset.key]); sess.term.focus(); }
  });

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
  if (WS.keyHandler) document.removeEventListener('keydown', WS.keyHandler);
  Object.assign(WS, { folders: [], hosts: [], identities: [], tabs: [], active: null, ctrl: false, term: null, ids: null, keyHandler: null });
}

'use strict';

/* Hosts, the command palette, identities, and SSH terminals. Uses ui.js helpers and app.js (api, showView, refresh). */

const DEFAULT_FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

// A workspace tab holds a tree of panes; each pane is one session (a terminal or a remote desktop).
//   node = { kind: 'leaf', sess } | { kind: 'split', dir: 'row' | 'col', ratio, a: node, b: node }
const WS = {
  folders: [], hosts: [], identities: [], commands: [], tabs: [], active: null, ctrl: false,
  term: null, ids: null, keyHandler: null, nextTab: 1, liveKey: '',
};
const MAX_PANES = 6;

const themeFor = name => xtermTheme(name);

function termPrefs() {
  try { return Object.assign({ font: DEFAULT_FONT, size: 14 }, JSON.parse(localStorage.getItem('sb_term') || '{}')); }
  catch (e) { return { font: DEFAULT_FONT, size: 14 }; }
}

function saveTermPrefs(p) {
  try { localStorage.setItem('sb_term', JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
  for (const sess of allSessions().filter(x => x.kind !== 'rdp')) {
    sess.term.options.fontFamily = p.font;
    sess.term.options.fontSize = p.size;
  }
  fitActive();
}

function paintTerminalTheme(sess) {
  const t = themeFor(sess.host.theme);
  sess.term.options.theme = t;
  sess.holder.style.setProperty('--term-bg', t.background); // ds-allow: a per-host colour read from the tokens
}
themeListeners.push(() => allSessions().filter(s => s.kind !== 'rdp').forEach(paintTerminalTheme));

function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch (e) { return new Set(); }
}
function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
const collapsed = readSet('sb_collapsed');
const saveCollapsed = () => writeList('sb_collapsed', [...collapsed]);

function recentHosts() {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem('sb_recent') || '[]'); } catch (e) { /* ignore */ }
  return ids.map(id => WS.hosts.find(h => h.id === id)).filter(Boolean).slice(0, 5);
}
function noteRecent(host) {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem('sb_recent') || '[]'); } catch (e) { /* ignore */ }
  writeList('sb_recent', [host.id, ...ids.filter(x => x !== host.id)].slice(0, 12));
}

const byName = (a, b) => a.name.localeCompare(b.name);
const protoIcon = h => (h.protocol === 'rdp' ? 'device-desktop' : 'terminal-2');

/* ---------- data ---------- */

async function loadHosts() {
  const r = await api('GET', '/hosts');
  WS.folders = r.folders;
  WS.hosts = r.hosts;
  renderTree();
  renderWelcome();
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

function liveHostIds() {
  return new Set(allSessions().filter(s => s.state === 'live').map(s => s.host.id));
}

function renderTree() {
  const tree = document.getElementById('tree');
  if (!tree) return;
  const live = liveHostIds();
  WS.liveKey = [...live].sort().join(',');
  if (!WS.hosts.length && !WS.folders.length) {
    tree.innerHTML = '<p class="faint tree-note">No hosts yet. Add one with the + above.</p>';
    return;
  }
  const walk = (parent, depth) => {
    let out = '';
    for (const f of WS.folders.filter(x => x.parent_id === parent).sort(byName)) {
      const open = !collapsed.has(f.id);
      out += `<div class="row folder d${Math.min(depth, 6)}">
        <button type="button" class="row-main" data-folder="${esc(f.id)}" aria-expanded="${open}">${icon('chevron-down', 'chev sm')}<span class="name">${esc(f.name)}</span></button>
        ${iconButton('dots', `Edit folder ${f.name}`, `data-edit-folder="${esc(f.id)}"`, 'kebab')}</div>`;
      if (open) out += walk(f.id, depth + 1);
    }
    for (const h of WS.hosts.filter(x => x.folder_id === parent).sort(byName)) out += hostRow(h, { depth, live: live.has(h.id) });
    return out;
  };
  tree.innerHTML = walk('', 0);
}

function bindTree() {
  const tree = document.getElementById('tree');
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
}

function renderWelcome() {
  const box = WS.term && document.getElementById('empty');
  if (!box) return;
  if (!WS.hosts.length) {
    box.innerHTML = `<div class="welcome-in">${icon('logo', 'mark')}
      <div><h1>Add your first host</h1><p class="sub muted">Connect to any server over SSH or RDP, from any browser. Your passwords and keys stay encrypted in your vault.</p></div>
      <button class="primary" id="welcome-add">${icon('plus')}New host</button></div>`;
    document.getElementById('welcome-add').addEventListener('click', () => hostDialog(null));
    return;
  }
  const recent = recentHosts();
  box.innerHTML = `<div class="welcome-in">${icon('logo', 'mark')}
    <div><h1>${recent.length ? 'Pick up where you left off' : 'Open a host'}</h1>
      <p class="sub muted">${recent.length ? 'Your recent hosts.' : 'Choose one from the sidebar.'}</p></div>
    ${recent.length ? `<div class="recent">${recent.map(h => `<button type="button" class="row host" data-open="${esc(h.id)}">${icon(protoIcon(h))}<span class="name">${esc(h.name)}</span>
      <span class="faint small">${esc((h.username ? h.username + '@' : '') + h.address)}</span></button>`).join('')}</div>` : ''}
    <p class="hint small">${icon('search', 'sm')}Search everything with <span class="kbd">${IS_MAC ? '⌘K' : 'Ctrl K'}</span></p></div>`;
  box.querySelectorAll('[data-open]').forEach(r => {
    const go = () => openHost(WS.hosts.find(h => h.id === r.dataset.open));
    r.addEventListener('click', go);
  });
}

/* ---------- host and folder dialogs ---------- */

const RDP_DEFAULTS = { width: 0, height: 0, depth: 32, layout: 'en-us-qwerty', wallpaper: false, smoothing: true, audio: true, clipboard: true, files: true };
const RDP_SIZES = ['1920x1080', '1600x900', '1366x768', '1280x720', '1024x768'];
const RDP_DEPTHS = [[32, 'True colour (32 bit)'], [24, 'True colour (24 bit)'], [16, 'High colour (16 bit, lighter on slow links)']];
const RDP_LAYOUTS = [['en-us-qwerty', 'English (US)'], ['en-gb-qwerty', 'English (UK)'], ['de-de-qwertz', 'German'], ['de-ch-qwertz', 'German (Swiss)'],
  ['fr-fr-azerty', 'French'], ['fr-be-azerty', 'French (Belgian)'], ['fr-ca-qwerty', 'French (Canadian)'], ['fr-ch-qwertz', 'French (Swiss)'],
  ['es-es-qwerty', 'Spanish'], ['es-latam-qwerty', 'Spanish (Latin America)'], ['it-it-qwerty', 'Italian'], ['pt-br-qwerty', 'Portuguese (Brazil)'],
  ['pt-pt-qwerty', 'Portuguese'], ['sv-se-qwerty', 'Swedish'], ['da-dk-qwerty', 'Danish'], ['no-no-qwerty', 'Norwegian'], ['pl-pl-qwerty', 'Polish'],
  ['tr-tr-qwerty', 'Turkish'], ['hu-hu-qwertz', 'Hungarian'], ['ja-jp-qwerty', 'Japanese']];

// The display and device settings from a submitted host dialog.
function rdpFromForm(fd) {
  const res = fd.get('res');
  let width = 0, height = 0;
  if (res === 'custom') {
    width = Number(fd.get('rw')); height = Number(fd.get('rh'));
    if (!width || !height) throw new Error('Enter a width and height for the custom size.');
    if (width < 320 || width > 7680 || height < 200 || height > 4320) throw new Error('The size must be between 320 × 200 and 7680 × 4320.');
  } else if (res !== 'fit') {
    [width, height] = res.split('x').map(Number);
  }
  const on = name => fd.get(name) !== null;
  return { width, height, depth: Number(fd.get('depth')), layout: fd.get('layout'),
    wallpaper: on('wallpaper'), smoothing: on('smoothing'), audio: on('audio'), clipboard: on('clipboard'), files: on('files') };
}

// opts.prefill fills a new host's fields; opts.thenOpen opens it once saved.
function hostDialog(host, opts = {}) {
  const defaults = { name: '', folder_id: '', address: '', port: 22, username: '', auth: 'password', identity_id: '', has_password: false, theme: 'auto', protocol: 'ssh', security: 'any', ignore_cert: true };
  const h = host || { ...defaults, ...(opts.prefill || {}) };
  const idOpts = WS.identities.length
    ? WS.identities.map(i => `<option value="${esc(i.id)}"${i.id === h.identity_id ? ' selected' : ''}>${esc(i.name)}</option>`).join('')
    : '<option value="">No identities yet</option>';
  const rdpOpts = { ...RDP_DEFAULTS, ...(h.rdp || {}) };
  const sizeKey = !rdpOpts.width ? 'fit' : RDP_SIZES.includes(`${rdpOpts.width}x${rdpOpts.height}`) ? `${rdpOpts.width}x${rdpOpts.height}` : 'custom';
  const sizeOpts = [['fit', 'Fit the window'], ...RDP_SIZES.map(v => [v, v.replace('x', ' × ')]), ['custom', 'Custom size…']]
    .map(([v, t]) => `<option value="${v}"${v === sizeKey ? ' selected' : ''}>${t}</option>`).join('');
  const depthOpts = RDP_DEPTHS.map(([v, t]) => `<option value="${v}"${v === rdpOpts.depth ? ' selected' : ''}>${t}</option>`).join('');
  const layoutOpts = RDP_LAYOUTS.map(([v, t]) => `<option value="${v}"${v === rdpOpts.layout ? ' selected' : ''}>${t}</option>`).join('');
  const themeOpts = ['auto', 'dark', 'light', 'contrast']
    .map(t => `<option value="${t}"${t === h.theme ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('');
  const d = dialog(host ? 'Edit host' : 'New host', `
    <div class="inline">
      <label>Name<input type="text" name="name" value="${esc(h.name)}" required maxlength="80"></label>
      <label class="narrow wider">Type<select name="protocol"><option value="ssh"${h.protocol !== 'rdp' ? ' selected' : ''}>SSH</option>
        <option value="rdp"${h.protocol === 'rdp' ? ' selected' : ''}>Desktop (RDP)</option></select></label>
    </div>
    <label>Folder<select name="folder_id">${folderOptions(h.folder_id)}<option value="__new">+ Add new folder</option></select></label>
    <div class="inline">
      <label>Address<input type="text" name="address" value="${esc(h.address)}" required autocapitalize="off" spellcheck="false"></label>
      <label class="narrow">Port<input type="number" name="port" value="${esc(h.port)}" min="1" max="65535" required></label>
    </div>
    <label>Username<input type="text" name="username" value="${esc(h.username)}" autocapitalize="off" spellcheck="false" autocomplete="off">
      <span class="small faint" data-proto="rdp">For a domain account, use DOMAIN\\user.</span></label>
    <label data-sshonly>Sign in with<select name="auth"><option value="password"${h.auth === 'password' ? ' selected' : ''}>Password</option>
      <option value="key"${h.auth === 'key' ? ' selected' : ''}>Identity (SSH key)</option></select></label>
    <label data-for="password">Password${passwordField({ name: 'password', placeholder: h.has_password ? 'Saved. Leave blank to keep it.' : '' })}</label>
    <label data-for="key" data-sshonly>Identity<select name="identity_id">${idOpts}</select></label>
    <label data-proto="rdp">Security<select name="security">${[['any', 'Automatic'], ['nla', 'Network Level Authentication'], ['tls', 'TLS'], ['rdp', 'Standard RDP (legacy)']]
      .map(([v, t]) => `<option value="${v}"${v === h.security ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="check" data-proto="rdp"><input type="checkbox" name="ignore_cert"${h.ignore_cert ? ' checked' : ''}> Accept self-signed certificates
      <span class="small">Windows PCs usually have one. Turn this off on networks you don't trust.</span></label>
    ${h.has_password ? '<label class="check"><input type="checkbox" name="forget"> Forget the saved password</label>' : ''}
    <details data-proto="rdp"><summary>Display and devices</summary>
      <label>Resolution<select name="res">${sizeOpts}</select></label>
      <div class="inline" id="rescustom"${sizeKey === 'custom' ? '' : ' hidden'}>
        <label>Width<input type="number" name="rw" min="320" max="7680" value="${rdpOpts.width || ''}"></label>
        <label>Height<input type="number" name="rh" min="200" max="4320" value="${rdpOpts.height || ''}"></label></div>
      <label>Colour depth<select name="depth">${depthOpts}</select></label>
      <label>Keyboard layout<select name="layout">${layoutOpts}</select></label>
      ${checkField('wallpaper', 'Show the desktop wallpaper', 'Off is faster on slow links.', '', rdpOpts.wallpaper)}
      ${checkField('smoothing', 'Smooth fonts', '', '', rdpOpts.smoothing)}
      ${checkField('audio', 'Play sound', '', '', rdpOpts.audio)}
      ${checkField('clipboard', 'Share the clipboard', 'Copy and paste between this browser and the desktop.', '', rdpOpts.clipboard)}
      ${checkField('files', 'Allow file transfer', 'Upload to and download from the desktop.', '', rdpOpts.files)}
    </details>
    <label data-sshonly>Terminal colours<select name="theme">${themeOpts}</select></label>`, {
    wide: true,
    extra: host ? '<button type="button" class="danger" data-del>Delete</button>' : '',
    onSubmit: async fd => {
      const rdp = fd.get('protocol') === 'rdp';
      const body = {
        name: fd.get('name'), folder_id: fd.get('folder_id'), address: fd.get('address'),
        port: Number(fd.get('port')), username: fd.get('username'), protocol: fd.get('protocol'),
        auth: rdp ? 'password' : fd.get('auth'),
        identity_id: !rdp && fd.get('auth') === 'key' ? fd.get('identity_id') : '', theme: rdp ? 'auto' : fd.get('theme'),
        security: fd.get('security'), ignore_cert: fd.get('ignore_cert') !== null,
        rdp: rdp ? rdpFromForm(fd) : undefined,
      };
      if (rdp && !host && !fd.get('password')) throw new Error('Enter the password for this host.');
      if (body.auth === 'key' && !body.identity_id) throw new Error('Choose an identity, or create one on the Identities page.');
      if (body.auth === 'password' && (fd.get('password') || !host)) body.password = fd.get('password');
      if (fd.get('forget') && !fd.get('password')) body.password = '';
      const saved = await api(host ? 'PUT' : 'POST', host ? '/hosts/' + host.id : '/hosts', body);
      await Promise.all([loadHosts(), loadIdentities()]);
      toast(host ? 'Host saved' : 'Host added');
      if (opts.thenOpen) openHost(WS.hosts.find(x => x.id === saved.id));
    },
  });

  const sync = () => {
    const proto = d.querySelector('[name=protocol]').value;
    const auth = d.querySelector('[name=auth]').value;
    d.querySelectorAll('[data-proto]').forEach(e => { e.hidden = e.dataset.proto !== proto; });
    d.querySelectorAll('[data-sshonly]').forEach(e => { e.hidden = proto === 'rdp'; });
    d.querySelectorAll('[data-for]').forEach(l => { l.hidden = proto === 'rdp' ? l.dataset.for !== 'password' : l.dataset.for !== auth; });
  };
  d.querySelector('[name=res]').addEventListener('change', ev => { d.querySelector('#rescustom').hidden = ev.target.value !== 'custom'; });
  const portField = d.querySelector('[name=port]');
  d.querySelector('[name=protocol]').addEventListener('change', ev => {
    // Swap the default port only if it still holds the other protocol's default.
    if (ev.target.value === 'rdp' && portField.value === '22') portField.value = '3389';
    if (ev.target.value === 'ssh' && portField.value === '3389') portField.value = '22';
    sync();
  });
  d.querySelector('[name=auth]').addEventListener('change', sync);
  sync();

  // The eye shows what is typed, or, for a saved password, asks for the account password and fetches it.
  const pw = d.querySelector('[name=password]');
  const forget = d.querySelector('[name=forget]');
  bindPasswordField(pw, host && h.has_password && !(forget && forget.checked) ? async () => {
    const asked = await new Promise(resolve => {
      const pd = passwordDialog('Show the saved password', 'Enter your account password to see it.', 'Show', async password => {
        const r = await api('POST', `/hosts/${host.id}/password`, { password });
        resolve(r.password);
      });
      pd.addEventListener('close', () => resolve(null));
    });
    return asked;
  } : null);
  if (forget) forget.addEventListener('change', () => { if (forget.checked) { pw.value = ''; pw.dispatchEvent(new Event('input')); } });

  // The last folder choice makes a new folder and then selects it.
  const folderSel = d.querySelector('[name=folder_id]');
  let folderPick = folderSel.value;
  folderSel.addEventListener('change', () => {
    if (folderSel.value !== '__new') { folderPick = folderSel.value; return; }
    folderDialog(null, made => {
      folderSel.innerHTML = folderOptions(made ? made.id : folderPick) + '<option value="__new">+ Add new folder</option>';
      folderPick = folderSel.value;
    });
  });

  const del = d.querySelector('[data-del]');
  if (del) del.addEventListener('click', () => {
    d.close();
    confirmDialog(`Delete ${host.name}?`, 'The host and its saved credentials are removed. Open terminals for it are closed.', 'Delete host', async () => {
      await api('DELETE', '/hosts/' + host.id);
      allSessions().filter(x => x.host.id === host.id).forEach(closeSession);
      await loadHosts();
      toast('Host deleted');
    });
  });
}

function folderDialog(folder, onClose = () => {}) {
  let saved = null;
  const d = dialog(folder ? 'Edit folder' : 'New folder', `
    <label>Name<input type="text" name="name" value="${esc(folder ? folder.name : '')}" required maxlength="80"></label>
    <label>Inside<select name="parent_id">${folderOptions(folder ? folder.parent_id : '', folder && folder.id)}</select></label>`, {
    extra: folder ? '<button type="button" class="danger" data-del>Delete</button>' : '',
    onSubmit: async fd => {
      saved = await api(folder ? 'PUT' : 'POST', folder ? '/folders/' + folder.id : '/folders', { name: fd.get('name'), parent_id: fd.get('parent_id') });
      await loadHosts();
      toast(folder ? 'Folder saved' : 'Folder added');
    },
  });
  d.addEventListener('close', () => onClose(saved));
  const del = d.querySelector('[data-del]');
  if (del) del.addEventListener('click', () => {
    d.close();
    confirmDialog(`Delete folder "${folder.name}"?`, 'Folders inside it are removed too. Hosts in them move to the top level.', 'Delete folder', async () => {
      await api('DELETE', '/folders/' + folder.id);
      await loadHosts();
      toast('Folder deleted');
    });
  });
}

/* ---------- command palette ---------- */

// With onPick set, the palette only chooses a host (used for splitting a pane).
function openPalette(opts = {}) {
  if (document.querySelector('dialog.palette')) return;
  const pick = opts.onPick;
  const d = el('dialog', 'palette');
  d.innerHTML = `<div class="pal-input">${icon('search')}<input type="text" placeholder="${esc(pick ? (opts.placeholder || 'Choose a host') : 'Search hosts, or type user@host to connect')}"
    autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${pick ? 'Choose a host' : 'Search hosts and actions'}" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list"></div>
    <div class="pal-list" id="pal-list" role="listbox" tabindex="-1" aria-label="Results"></div>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  const input = d.querySelector('input');
  const list = d.querySelector('.pal-list');
  let items = [];
  let cursor = 0;

  const actions = pick ? [] : [
    { label: 'New host', icon: 'plus', run: () => hostDialog(null) },
    { label: 'New folder', icon: 'folder-plus', run: () => folderDialog(null) },
    { label: 'New identity', icon: 'key', run: () => { showView('identities'); newIdentityDialog(); } },
    { label: 'Identities', icon: 'key', hint: 'Page', run: () => showView('identities') },
    { label: 'Settings', icon: 'settings', hint: 'Page', run: () => showView('settings') },
    ...(cmdBarHidden() ? [{ label: 'Show saved commands bar', icon: 'terminal-2', run: () => setCmdBarHidden(false) }] : []),
    { label: 'Switch theme', icon: themeEffective() === 'dark' ? 'sun' : 'moon', run: () => setThemeChoice(themeEffective() === 'dark' ? 'light' : 'dark') },
    { label: 'Sign out', icon: 'logout', run: signOut },
  ];

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const match = h => `${h.name} ${h.address} ${h.username} ${folderPath(h.folder_id)}`.toLowerCase().includes(q);
    const hostItem = h => ({ label: h.name, icon: protoIcon(h), hint: folderPath(h.folder_id) || ((h.username ? h.username + '@' : '') + h.address), run: () => (pick ? pick(h) : openHost(h)) });
    const groups = [];
    if (!q) {
      const recent = recentHosts();
      if (recent.length && !pick) groups.push(['Recent', recent.map(hostItem)]);
      groups.push(['Hosts', [...WS.hosts].sort(byName).map(hostItem)]);
    } else {
      const hosts = WS.hosts.filter(match).sort(byName).map(hostItem);
      if (hosts.length) groups.push(['Hosts', hosts]);
      const m = q.match(/^(?:([\w.-]+)@)?([\w.-]+)(?::(\d{1,5}))?$/i);
      if (!pick && m && (q.includes('@') || q.includes('.') || q.includes(':'))) {
        groups.push(['Connect', [{
          label: `Add and connect to ${input.value.trim()}`, icon: 'plus',
          run: () => hostDialog(null, { thenOpen: true, prefill: { name: m[2], address: m[2], username: m[1] || '', port: m[3] ? Number(m[3]) : 22 } }),
        }]]);
      }
      const acts = actions.filter(a => a.label.toLowerCase().includes(q));
      if (acts.length) groups.push(['Actions', acts]);
    }
    if (!q && actions.length) groups.push(['Actions', actions]);
    items = groups.flatMap(g => g[1]);
    cursor = Math.min(cursor, Math.max(items.length - 1, 0));
    let n = 0;
    list.innerHTML = items.length ? groups.map(([title, rows]) => `<div role="group" aria-label="${esc(title)}"><div class="pal-group" aria-hidden="true">${esc(title)}</div>${rows.map(r =>
      `<div class="pal-row${n++ === cursor ? ' on' : ''}" role="option" id="pal-opt-${n - 1}" aria-selected="${n - 1 === cursor}" data-i="${n - 1}">${icon(r.icon)}<span>${esc(r.label)}</span>${r.hint ? `<span class="hint">${esc(r.hint)}</span>` : ''}</div>`).join('')}</div>`).join('')
      : `<div class="pal-empty" role="option" aria-disabled="true">${pick ? 'No matching hosts.' : 'Nothing matches.'}</div>`;
    setActive();
  };
  const setActive = () => {
    list.querySelectorAll('.pal-row').forEach(r => {
      const on = Number(r.dataset.i) === cursor;
      r.classList.toggle('on', on);
      r.setAttribute('aria-selected', on);
    });
    if (items.length) input.setAttribute('aria-activedescendant', 'pal-opt-' + cursor); else input.removeAttribute('aria-activedescendant');
  };
  const run = i => { const it = items[i]; if (!it) return; d.close(); setTimeout(it.run, 0); };
  const move = delta => {
    if (!items.length) return;
    cursor = (cursor + delta + items.length) % items.length;
    setActive();
    const on = list.querySelector('.pal-row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { cursor = 0; draw(); });
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); run(cursor); }
  });
  list.addEventListener('click', ev => { const r = ev.target.closest('.pal-row'); if (r) run(Number(r.dataset.i)); });
  list.addEventListener('mousemove', ev => {
    const r = ev.target.closest('.pal-row');
    if (r && Number(r.dataset.i) !== cursor) { cursor = Number(r.dataset.i); setActive(); }
  });
  d.addEventListener('click', ev => { if (ev.target === d) d.close(); });
  draw();
  d.showModal();
  input.focus();
}

function pickHost(title, done) { openPalette({ onPick: done, placeholder: title }); }

/* ---------- panes and sessions ---------- */

const encoder = new TextEncoder();

function leaves(node) { return !node ? [] : node.kind === 'leaf' ? [node.sess] : [...leaves(node.a), ...leaves(node.b)]; }
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

// Overlays sit over a pane to say what is happening or ask a question.
let overlaySeq = 0;
function showOverlay(sess, { title, text = '', tone = '', buttons = [] }) {
  const o = sess.overlay;
  o.hidden = false;
  const oid = sess.ovId = sess.ovId || ++overlaySeq;
  o.innerHTML = `<div class="tbox ${tone}" role="alertdialog" aria-labelledby="ov-title-${oid}" ${text ? `aria-describedby="ov-text-${oid}"` : ''}>
    <div class="tb-head">${tone === 'danger' ? `<span class="tb-icon">${icon('alert-triangle')}</span>` : ''}
      <div class="tb-copy"><div class="title" id="ov-title-${oid}">${title}</div>${text ? `<div class="text" id="ov-text-${oid}">${text}</div>` : ''}</div></div>
    <div class="actions"></div></div>`;
  const actions = o.querySelector('.actions');
  for (const b of buttons) {
    if (b.close) {
      // Closing the pane is the x in the corner, not one of the choices.
      o.querySelector('.tbox').insertAdjacentHTML('beforeend', iconButton('x', 'Close pane', 'data-close', 'sm'));
      o.querySelector('[data-close]').addEventListener('click', b.fn);
      continue;
    }
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
function closeButton(sess) { return { close: true, fn: () => closeSession(sess) }; }

function setState(sess, state) {
  sess.state = state;
  updateHead(sess);
  renderTabs();
  refreshLive();
}

// The sidebar shows a dot beside hosts that are connected.
function refreshLive() {
  const key = [...liveHostIds()].sort().join(',');
  if (key !== WS.liveKey) renderTree();
}

function updateHead(sess) {
  const head = sess.head;
  head.querySelector('.dot').className = 'dot ' + sess.state;
  head.querySelector('.pname').textContent = sess.host.name;
}

function newSession(host, wtab) {
  return host.protocol === 'rdp' ? newRdpSession(host, wtab) : newSshSession(host, wtab);
}

// Give keyboard focus to a pane's terminal or remote desktop.
function sessFocus(sess) {
  if (!sess) return;
  if (sess.kind === 'rdp') rdpFocus(sess); else sess.term.focus();
}

function newSshSession(host, wtab) {
  const prefs = termPrefs();
  const pane = el('div', 'pane');
  pane.innerHTML = `
    <div class="phead"><span class="dot"></span><span class="pname"></span><span class="grow"></span>
      ${iconButton('layout-columns', 'Split right', 'data-act="split-row"')}
      ${iconButton('layout-rows', 'Split down', 'data-act="split-col"')}
      ${iconButton('x', 'Close pane', 'data-act="close"')}</div>
    <div class="term"></div>
    <div class="tover" hidden></div>`;
  const term = new Terminal({
    fontFamily: prefs.font, fontSize: prefs.size, cursorBlink: true, scrollback: 5000,
    theme: themeFor(host.theme),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const sess = {
    kind: 'ssh', host, wtab, term, fit, pane, head: pane.querySelector('.phead'),
    holder: pane.querySelector('.term'), overlay: pane.querySelector('.tover'),
    sock: null, state: 'connecting', retries: 0, timer: null, closed: false, connectedBefore: false, opened: false,
  };
  sess.holder.style.setProperty('--term-bg', themeFor(host.theme).background); // ds-allow: a per-host colour read from the tokens
  sess.ro = new ResizeObserver(() => requestAnimationFrame(() => fitSess(sess)));
  sess.ro.observe(sess.holder);

  pane.addEventListener('pointerdown', () => focusSession(sess), true);
  pane.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') closeSession(sess);
    else splitSession(sess, b.dataset.act === 'split-row' ? 'row' : 'col');
  });
  updateHead(sess);
  return sess;
}

// The terminal can only be opened once its pane is in the page.
function ensureOpen(sess) {
  if (sess.kind === 'rdp') return rdpOpen(sess);
  if (sess.opened) return;
  sess.opened = true;
  sess.term.open(sess.holder);
  // Tab belongs to the shell, so Shift+Escape is the way out for keyboard users.
  sess.term.textarea.setAttribute('aria-label', `Terminal for ${sess.host.name}. Press Shift+Escape to leave it.`);
  sess.term.attachCustomKeyEventHandler(ev => {
    if (ev.type === 'keydown' && ev.key === 'Escape' && ev.shiftKey) {
      sess.head.querySelector('button').focus();
      return false;
    }
    return true;
  });
  sess.term.onData(d => sendInput(sess, d));
  sess.term.onBinary(d => { if (sess.state === 'live' && sess.sock.readyState === 1) sess.sock.send(Uint8Array.from(d, c => c.charCodeAt(0))); });
  sess.term.onResize(({ cols, rows }) => sendCtl(sess, { type: 'resize', cols, rows }));
}

function fitSess(sess) {
  if (sess.kind === 'rdp') return rdpFit(sess);
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
  if (sess.kind === 'rdp') return rdpConnect(sess);
  clearTimeout(sess.timer);
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

const sentence = t => (t ? t[0].toUpperCase() + t.slice(1) : '');

function onControl(sess, m) {
  const retry = { label: 'Retry', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } };
  switch (m.type) {
    case 'hostkey': {
      setState(sess, 'hostkey');
      const name = esc(m.host || sess.host.name);
      const answer = accept => () => { sendCtl(sess, { type: 'trust', accept }); showOverlay(sess, { title: 'Connecting…' }); };
      if (m.changed) {
        showOverlay(sess, {
          tone: 'danger', title: `The host key for ${name} has changed`,
          text: `Someone may be intercepting this connection, or the server was reinstalled. Only continue if you know why.
            <span class="fp-label">Saved</span><code class="fp">${esc(m.old_fingerprint)}</code><span class="fp-label">Now (${esc(m.key_type)})</span><code class="fp">${esc(m.fingerprint)}</code>`,
          buttons: [{ label: 'Disconnect', cls: 'primary', fn: answer(false) }, { label: 'Accept new key', cls: 'danger', fn: answer(true) }],
        });
      } else {
        showOverlay(sess, {
          title: `First connection to ${name}`,
          text: `Check that this fingerprint is the server you expect before you continue.<span class="fp-label">${esc(m.key_type)}</span><code class="fp">${esc(m.fingerprint)}</code>`,
          buttons: [{ label: 'Trust and connect', cls: 'primary', fn: answer(true) }, { label: 'Cancel', cls: 'quiet', fn: answer(false) }],
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
      if (WS.active && WS.active.active === sess) sessFocus(sess);
      break;
    case 'error':
      if (m.retry && sess.connectedBefore && sess.retries < 8) { scheduleReconnect(sess); break; }
      setState(sess, 'fatal');
      showOverlay(sess, {
        tone: 'danger', title: sess.connectedBefore ? 'Connection lost' : `Could not connect to ${esc(sess.host.name)}`,
        text: esc(sentence(m.message) || 'The server did not say why. Check the host address and port, then try again.'), buttons: [retry, closeButton(sess)],
      });
      break;
    case 'closed':
      setState(sess, 'ended');
      showOverlay(sess, { title: 'Session ended', text: 'The host closed the session.', buttons: [{ label: 'Reconnect', cls: 'primary', fn: () => connect(sess) }, closeButton(sess)] });
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
    title: 'Connection lost. Reconnecting…', text: `Trying again in ${Math.round(delay / 1000)} s.`,
    buttons: [{ label: 'Retry now', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } }, closeButton(sess)],
  });
  clearTimeout(sess.timer);
  sess.timer = setTimeout(() => connect(sess), delay);
}

// Whether this browser is still signed in: true, false, or null when the server can't be reached.
async function signedIn() {
  try { return !!(await (await fetch('/api/state', { credentials: 'same-origin' })).json()).user; } catch (e) { return null; }
}

async function onClosed(sess, ev) {
  if (['fatal', 'ended', 'lost'].includes(sess.state)) return;
  // A restart or timeout signs everyone out, and retrying would never work: go to the sign-in page.
  if (ev.code === 4401 || (await signedIn()) === false) return webSessionEnded();
  if (sess.closed || ['fatal', 'ended', 'lost'].includes(sess.state)) return;
  if (!sess.connectedBefore || sess.retries >= 8) {
    setState(sess, 'fatal');
    explainClose(sess, ev);
    return;
  }
  scheduleReconnect(sess);
}

// The web session is gone, so every pane is dead: show the sign-in page.
async function webSessionEnded() {
  await refresh();
  toast('You were signed out. Sign in again to continue.', 'err');
}

// The socket closed without the server saying why, so find out what we can.
async function explainClose(sess, ev) {
  const retry = { label: 'Retry', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } };
  const name = esc(sess.host.name);
  let st = null;
  try { st = await (await fetch('/api/state', { credentials: 'same-origin' })).json(); } catch (e) { /* unreachable */ }
  if (sess.closed) return;
  if (st && !st.user) return webSessionEnded();
  if (!st) {
    showOverlay(sess, {
      tone: 'danger', title: 'Cannot reach Switchboard',
      text: 'Your browser lost its connection to the Switchboard server. Check that the server is running and that your network or reverse proxy is up, then retry.',
      buttons: [retry, closeButton(sess)],
    });
    return;
  }
  showOverlay(sess, {
    tone: 'danger', title: sess.connectedBefore ? `Connection to ${name} lost` : `Could not connect to ${name}`,
    text: `The connection closed before ${name} answered (code ${ev.code || 'none'}). Behind a reverse proxy, make sure it passes WebSocket connections through and keeps the Host header unchanged.`,
    buttons: [retry, closeButton(sess)],
  });
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
  a.style.flex = `${node.ratio} 1 0`; // ds-allow: the divider position is dynamic
  b.style.flex = `${1 - node.ratio} 1 0`; // ds-allow: the divider position is dynamic
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
    a.style.flex = `${node.ratio} 1 0`; // ds-allow: the divider position is dynamic
    b.style.flex = `${1 - node.ratio} 1 0`; // ds-allow: the divider position is dynamic
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
  noteRecent(host);
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
  if (leaves(wtab.root).length >= MAX_PANES) { toast(`A tab holds at most ${MAX_PANES} panes`, 'err'); return; }
  pickHost(dir === 'row' ? 'Open beside this pane' : 'Open below this pane', host => {
    if (!host || sess.closed || !WS.tabs.includes(wtab)) return;
    noteRecent(host);
    const added = newSession(host, wtab);
    const leaf = findLeaf(wtab.root, sess);
    wtab.root = replaceNode(wtab.root, leaf, { kind: 'split', dir, ratio: 0.5, a: leaf, b: { kind: 'leaf', sess: added } });
    wtab.active = added;
    renderLayout(wtab);
    connect(added);
    sessFocus(added);
  });
}

function teardown(sess) {
  if (sess.kind === 'rdp') return rdpTeardown(sess);
  sess.closed = true;
  clearTimeout(sess.timer);
  sess.ro.disconnect();
  try { if (sess.sock) sess.sock.close(); } catch (e) { /* already closed */ }
  sess.term.dispose();
  sess.pane.remove();
}

function closeSession(sess) {
  const wtab = sess.wtab;
  const rest = removeLeaf(wtab.root, sess);
  if (!rest) return closeTab(wtab); // the last pane: closing the tab also tears it down
  teardown(sess);
  wtab.root = rest;
  if (wtab.active === sess) wtab.active = leaves(wtab.root)[0];
  renderLayout(wtab);
  renderTabs();
  refreshLive();
  if (WS.active === wtab) sessFocus(wtab.active);
}

function closeTab(wtab) {
  leaves(wtab.root).forEach(teardown);
  wtab.el.remove();
  const i = WS.tabs.indexOf(wtab);
  WS.tabs.splice(i, 1);
  if (WS.active === wtab) activateTab(WS.tabs[Math.min(i, WS.tabs.length - 1)] || null);
  else renderTabs();
  refreshLive();
  if (!WS.tabs.length) renderWelcome();
}

function activateTab(wtab) {
  WS.active = wtab;
  for (const t of WS.tabs) t.el.hidden = t !== wtab;
  $q(WS.term, '#empty').hidden = !!wtab;
  toggleSide(false);
  renderTabs();
  requestAnimationFrame(() => { if (wtab) { fitActive(); sessFocus(wtab.active); } });
}

function renderTabs() {
  if (!WS.term) return;
  const strip = $q(WS.term, '#tabs');
  strip.hidden = !WS.tabs.length;
  strip.innerHTML = WS.tabs.map(t => {
    const all = leaves(t.root);
    const n = all.length;
    const label = esc(all[0].host.name) + (n > 1 ? ` <span class="faint">+${n - 1}</span>` : '');
    return `<div class="tab${t === WS.active ? ' on' : ''}">
      <button type="button" class="tab-main" data-tab="${t.id}" ${t === WS.active ? 'aria-current="true"' : ''} aria-label="${esc(all[0].host.name)}${n > 1 ? `, ${n} panes` : ''}, ${esc(t.active.state)}">${icon(protoIcon(all[0].host))}<span class="label">${label}</span><span class="dot ${t.active.state}" aria-hidden="true"></span></button>
      ${iconButton('x', `Close ${all[0].host.name}`, `data-close="${t.id}"`, 'tab-x')}
    </div>`;
  }).join('') + iconButton('plus', 'Open a host', 'data-new', 'plus');
  renderCmdBar();
}

/* ---------- saved commands ----------
   A bar of buttons under SSH terminals. Click inserts the command, Shift-click runs it. The text
   is stored encrypted for the signed-in user; {{host}} and {{user}} are filled in from the host. */

const CMDBAR_KEY = 'sb_cmdbar_hidden';
function cmdBarHidden() { try { return localStorage.getItem(CMDBAR_KEY) === '1'; } catch (e) { return false; } }
function setCmdBarHidden(hidden) {
  try { localStorage.setItem(CMDBAR_KEY, hidden ? '1' : '0'); } catch (e) { /* not saved */ }
  renderCmdBar();
  fitActive();
}

async function loadCommands() {
  WS.commands = await api('GET', '/commands');
  renderCmdBar();
}

function fillCommand(body, host) {
  return body.replaceAll('{{host}}', host.address).replaceAll('{{user}}', host.username || '');
}

function renderCmdBar() {
  const bar = WS.term && $q(WS.term, '#cmdbar');
  if (!bar) return;
  const sess = WS.active && WS.active.active;
  const show = !!sess && sess.kind !== 'rdp' && !cmdBarHidden();
  const wasHidden = bar.hidden;
  bar.hidden = !show;
  if (!show) { if (!wasHidden) fitActive(); return; }
  const sig = JSON.stringify(WS.commands);
  if (!wasHidden && bar.dataset.sig === sig) return; // nothing changed: leave focus where it is
  bar.dataset.sig = sig;
  const chips = WS.commands.length
    ? WS.commands.map(c => `<button type="button" class="cmd" data-cmd="${esc(c.id)}" title="${esc(c.body)}">${esc(c.name)}</button>`).join('')
    : '<span class="small faint">Save the commands you type often, and run them from here.</span>';
  const keep = bar.querySelector('.cmd-chips');
  const scroll = keep ? keep.scrollLeft : 0;
  bar.innerHTML = `${icon('terminal-2', 'faint')}<div class="cmd-chips">${chips}</div>
    ${iconButton('plus', 'Add a command', 'data-cmd-add')}${WS.commands.length ? iconButton('pencil', 'Manage commands', 'data-cmd-manage') : ''}${iconButton('chevron-down', 'Hide the commands bar', 'data-cmd-hide')}`;
  bar.querySelector('.cmd-chips').scrollLeft = scroll;
  if (wasHidden) fitActive();
}

function bindCommandBar() {
  const bar = $q(WS.term, '#cmdbar');
  // Keep focus in the terminal while a button is pressed with the mouse.
  bar.addEventListener('mousedown', ev => { if (ev.target.closest('[data-cmd]')) ev.preventDefault(); });
  bar.addEventListener('click', ev => {
    const chip = ev.target.closest('[data-cmd]');
    if (chip) return useCommand(WS.commands.find(c => c.id === chip.dataset.cmd), ev.shiftKey);
    if (ev.target.closest('[data-cmd-add]')) return commandDialog(null);
    if (ev.target.closest('[data-cmd-manage]')) return manageCommands();
    if (ev.target.closest('[data-cmd-hide]')) {
      setCmdBarHidden(true);
      toast('Commands bar hidden. Bring it back from the search (Ctrl K).');
    }
  });
}

// Puts the command at the cursor, and presses Enter too when run is set. Several lines always ask first.
function useCommand(cmd, run) {
  const sess = WS.active && WS.active.active;
  if (!cmd || !sess || sess.kind === 'rdp') return;
  if (sess.state !== 'live') { toast('This session is not connected.', 'err'); return; }
  const text = fillCommand(cmd.body, sess.host);
  const go = () => {
    sess.term.paste(text);
    if (run) sendRaw(sess, '\r');
    sess.term.focus();
  };
  if (!text.includes('\n')) return go();
  confirmDialog(`${run ? 'Run' : 'Insert'} "${cmd.name}"?`, `This has ${text.split('\n').length} lines, and each one may run as soon as it is inserted.<code class="block">${esc(text)}</code>`,
    run ? 'Run' : 'Insert', go, false);
}

function commandDialog(cmd, done) {
  dialog(cmd ? 'Edit command' : 'New command', `
    <label>Name<input type="text" name="name" maxlength="60" value="${esc(cmd ? cmd.name : '')}" autocomplete="off" required></label>
    <label>Command<textarea name="body" rows="4" class="mono" spellcheck="false" autocapitalize="off" autocomplete="off" required>${esc(cmd ? cmd.body : '')}</textarea></label>`, {
    description: 'Stored encrypted in your vault. <code>{{host}}</code> and <code>{{user}}</code> are replaced with the host address and username.',
    onSubmit: async fd => {
      const body = { name: fd.get('name'), body: fd.get('body') };
      if (cmd) await api('PUT', '/commands/' + cmd.id, body); else await api('POST', '/commands', body);
      await loadCommands();
      if (done) done();
    },
  });
}

// Edit, reorder and delete, with buttons rather than dragging.
function manageCommands() {
  const d = dialog('Saved commands', '', { extra: button('New command', { icon: 'plus', attrs: 'type="button" data-new-cmd' }) });
  const draw = () => {
    const list = WS.commands;
    d.querySelector('.dlg-body').innerHTML = `<p class="muted">Shift-click a button to run it instead of inserting it.</p>` + (list.length ? panel(list.map((c, i) => itemRow({
      title: esc(c.name),
      meta: `<div class="meta mono">${esc(c.body.split('\n')[0])}${c.body.includes('\n') ? ' …' : ''}</div>`,
      actions: `${iconButton('arrow-up', `Move ${c.name} earlier`, `data-up="${i}" ${i === 0 ? 'disabled' : ''}`)}
        ${iconButton('arrow-up', `Move ${c.name} later`, `data-down="${i}" ${i === list.length - 1 ? 'disabled' : ''}`, 'rot-180')}
        ${iconButton('pencil', `Edit ${c.name}`, `data-edit="${i}"`)}
        ${iconButton('trash', `Delete ${c.name}`, `data-del="${i}"`)}`,
    })).join('')) : '<p class="muted">No commands yet.</p>');
  };
  const reorder = async (i, j) => {
    const ids = WS.commands.map(c => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('POST', '/commands/order', { ids });
    await loadCommands();
    draw();
  };
  d.addEventListener('click', async ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.up !== undefined) await reorder(Number(b.dataset.up), Number(b.dataset.up) - 1);
      else if (b.dataset.down !== undefined) await reorder(Number(b.dataset.down), Number(b.dataset.down) + 1);
      else if (b.dataset.edit !== undefined) commandDialog(WS.commands[Number(b.dataset.edit)], draw);
      else if (b.dataset.del !== undefined) {
        const c = WS.commands[Number(b.dataset.del)];
        confirmDialog(`Delete "${c.name}"?`, 'It is removed from your saved commands.', 'Delete command', async () => {
          await api('DELETE', '/commands/' + c.id);
          await loadCommands();
          draw();
        });
      } else if ('newCmd' in b.dataset) commandDialog(null, draw);
    } catch (e) { toast(e.message, 'err'); }
  });
  draw();
}

/* ---------- identities ---------- */

function renderIdentities() {
  if (!WS.ids) return;
  const items = WS.identities.map(i => itemRow({
    lead: icon('key', 'lg faint'),
    title: esc(i.name), tags: tag(i.kind === 'rsa' ? 'RSA-4096' : 'Ed25519'),
    meta: `<div class="meta mono">${esc(i.fingerprint)}</div>
      <div class="meta">${i.deployed.length ? `Pushed to ${esc(i.deployed.join(', '))}` : 'Not pushed to any host yet'}${i.comment ? ` \u00b7 ${esc(i.comment)}` : ''}</div>`,
    actions: `${button('Push to hosts', { kind: 'sm', icon: 'send', attrs: `data-push="${esc(i.id)}"` })}
      ${iconButton('copy', 'Copy public key', `data-pub="${esc(i.id)}"`)}
      ${iconButton('download', 'Export private key', `data-export="${esc(i.id)}"`)}
      ${iconButton('trash', `Delete ${i.name}`, `data-delid="${esc(i.id)}"`)}`,
  })).join('');
  WS.ids.innerHTML = `<div class="page"><div class="page-in">
    ${pageHead('Identities', 'SSH key pairs. Private keys stay encrypted in your vault and never reach the browser unless you export one.',
      `${button('Import key', { icon: 'upload', attrs: 'id="id-import"' })}${button('New identity', { kind: 'primary', icon: 'plus', attrs: 'id="id-new"' })}`)}
    ${panel(items || emptyState('No identities yet', 'Create one, then push it to your servers to sign in without a password.'))}
  </div></div>`;
}

function identityDefaults() {
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return { name: `Key ${ym}`, comment: `${state.user.username}@switchboard-${ym}` };
}

function newIdentityDialog() {
  const def = identityDefaults();
  let created = null;
  const d = dialog('New identity', `
    <label>Name<input type="text" name="name" value="${esc(def.name)}" required maxlength="80"></label>
    <label>Comment<input type="text" name="comment" value="${esc(def.comment)}" maxlength="120"></label>
    <label>Type<select name="kind"><option value="ed25519">Ed25519 (recommended)</option><option value="rsa">RSA-4096 (slow to generate)</option></select></label>`, {
    submitLabel: 'Generate',
    onSubmit: async fd => {
      created = await api('POST', '/identities/generate', { name: fd.get('name'), comment: fd.get('comment'), kind: fd.get('kind') });
      await loadIdentities();
    },
  });
  // Next step: put the new key on the servers it is for.
  d.addEventListener('close', () => { if (created) pushDialog(WS.identities.find(i => i.id === created.id) || created); });
}

function pushDialog(ident) {
  const sshHosts = WS.hosts.filter(h => h.protocol !== 'rdp');
  if (!sshHosts.length) {
    dialog(`Push ${ident.name}`, '', { description: 'Add an SSH host first, then push this key to it from the Identities page.' });
    return;
  }
  const hosts = [...sshHosts].sort((a, b) => folderPath(a.folder_id).localeCompare(folderPath(b.folder_id)) || byName(a, b));
  const rows = hosts.map(h => {
    const hint = [folderPath(h.folder_id), (h.username ? h.username + '@' : '') + h.address].filter(Boolean).join(' · ');
    return `<label class="check prow" data-id="${esc(h.id)}"><input type="checkbox" value="${esc(h.id)}">
      <span class="pname2">${esc(h.name)}</span><span class="faint small">${esc(hint)}</span><span class="res"></span></label>`;
  }).join('');
  const d = dialog(`Push "${ident.name}" to hosts`, `
    <input type="search" id="pq" placeholder="Filter hosts" autocomplete="off" aria-label="Filter hosts">
    <label class="check"><input type="checkbox" id="pall"> Select all shown</label>
    <div class="pushlist">${rows}</div>
    <p class="muted small" id="psum"></p>`, {
    wide: true,
    description: `Adds this key's public half to each host's <code>~/.ssh/authorized_keys</code>, checks that signing in with it works, then makes the host use it. Each host signs in with its current credentials first, and its host key must already be trusted: open it in a terminal once if you haven't.`,
    actions: '<button type="button" class="primary" id="pgo">Push</button>',
  });
  const list = d.querySelector('.pushlist');
  const rowEls = [...list.querySelectorAll('.prow')];
  const boxOf = r => r.querySelector('input');
  const shown = () => rowEls.filter(r => !r.hidden);
  const err = d.querySelector('.err');

  d.querySelector('#pq').addEventListener('input', ev => {
    const t = ev.target.value.trim().toLowerCase();
    for (const r of rowEls) r.hidden = !!t && !r.textContent.toLowerCase().includes(t);
  });
  d.querySelector('#pq').addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });
  d.querySelector('#pall').addEventListener('change', ev => { for (const r of shown()) boxOf(r).checked = ev.target.checked; });

  const show = (row, cls, text) => {
    const res = row.querySelector('.res');
    res.className = 'res ' + cls;
    res.textContent = text;
  };
  const go = d.querySelector('#pgo');
  go.addEventListener('click', async () => {
    const todo = rowEls.filter(r => boxOf(r).checked);
    err.textContent = '';
    if (!todo.length) { err.textContent = 'Choose at least one host.'; return; }
    go.disabled = true;
    d.querySelectorAll('input').forEach(i => { i.disabled = true; });
    const tally = { added: 0, present: 0, failed: 0 };
    let next = 0;
    // Three hosts at a time; each one reports as it finishes.
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, async () => {
      while (next < todo.length) {
        const row = todo[next++];
        show(row, 'work', 'Pushing…');
        try {
          const r = await api('POST', `/identities/${ident.id}/push`, { host_id: row.dataset.id });
          if (r.result === 'error') { tally.failed++; show(row, 'bad', r.message); }
          else if (r.result === 'present') { tally.present++; show(row, 'ok', 'Already there. The host now uses this key.'); boxOf(row).checked = false; }
          else { tally.added++; show(row, 'ok', 'Key added and working.'); boxOf(row).checked = false; }
        } catch (e) {
          tally.failed++;
          show(row, 'bad', e.message);
        }
      }
    }));
    d.querySelectorAll('input').forEach(i => { i.disabled = false; });
    go.disabled = false;
    go.textContent = tally.failed ? 'Retry failed' : 'Push';
    d.querySelector('#psum').textContent = `${tally.added} added, ${tally.present} already there, ${tally.failed} failed.`;
    await Promise.all([loadHosts(), loadIdentities()]);
  });
}

function importIdentityDialog() {
  dialog('Import key', `
    <label>Name<input type="text" name="name" required maxlength="80"></label>
    <label>Private key<textarea name="private_key" rows="6" required spellcheck="false" autocomplete="off" class="mono"
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
      toast('Key imported');
    },
  });
}

function exportIdentityDialog(id) {
  passwordDialog('Export private key', 'Anyone with this key can sign in to every host that trusts it. Only export it if you need it elsewhere.', 'Show key', async password => {
    const r = await api('POST', `/identities/${id}/export`, { password });
    setTimeout(() => {
      const view = dialog('Private key', `<textarea readonly rows="8" class="mono" spellcheck="false">${esc(r.private_key)}</textarea>`, {
        extra: '<button type="button" data-copy>Copy</button>',
      });
      view.querySelector('[data-copy]').addEventListener('click', () => copyText(r.private_key));
      view.addEventListener('close', () => { const t = view.querySelector('textarea'); if (t) t.value = ''; });
    }, 200);
  });
}

function bindIdentities() {
  WS.ids.addEventListener('click', ev => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.id === 'id-new') return newIdentityDialog();
    if (t.id === 'id-import') return importIdentityDialog();
    if (t.dataset.push) return pushDialog(WS.identities.find(i => i.id === t.dataset.push));
    if (t.dataset.pub) return copyText(WS.identities.find(i => i.id === t.dataset.pub).public_key, 'Public key copied');
    if (t.dataset.export) return exportIdentityDialog(t.dataset.export);
    if (t.dataset.delid) {
      const i = WS.identities.find(x => x.id === t.dataset.delid);
      const used = i.hosts.length ? ` ${i.hosts.length} host${i.hosts.length === 1 ? ' uses' : 's use'} it and will need another way to sign in.` : '';
      confirmDialog(`Delete "${i.name}"?`, `The private key is destroyed.${used}`, 'Delete identity', async () => {
        await api('DELETE', '/identities/' + i.id);
        await Promise.all([loadIdentities(), loadHosts()]);
        toast('Identity deleted');
      });
    }
  });
}

/* ---------- mount ---------- */

function mountWorkspace(shellEl, termRoot, idRoot) {
  WS.term = termRoot;
  WS.ids = idRoot;
  termRoot.innerHTML = `
    <nav class="tabs" id="tabs" aria-label="Open sessions" hidden></nav>
    <div class="panes" id="panes"><div class="welcome" id="empty"></div></div>
    <div class="cmdbar" id="cmdbar" role="toolbar" aria-label="Saved commands" hidden></div>
    <div class="keybar" id="keybar" aria-label="Terminal keys">
      <button type="button" data-key="esc">Esc</button><button type="button" data-key="ctrl" aria-pressed="false">Ctrl</button><button type="button" data-key="tab">Tab</button>
      <button type="button" data-key="left" aria-label="Left">${icon('arrow-up', 'rot-270')}</button><button type="button" data-key="down" aria-label="Down">${icon('arrow-up', 'rot-180')}</button>
      <button type="button" data-key="up" aria-label="Up">${icon('arrow-up')}</button><button type="button" data-key="right" aria-label="Right">${icon('arrow-up', 'rot-90')}</button>
    </div>`;
  bindTree();
  bindIdentities();
  bindCommandBar();
  document.getElementById('add-host').addEventListener('click', () => hostDialog(null));
  document.getElementById('add-folder').addEventListener('click', () => folderDialog(null));
  document.getElementById('find').addEventListener('click', () => openPalette());

  $q(termRoot, '#tabs').addEventListener('click', ev => {
    if (ev.target.closest('[data-new]')) return openPalette();
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
    if (sess && sess.kind !== 'rdp') { sendRaw(sess, keys[b.dataset.key]); sess.term.focus(); }
  });

  // Ctrl+K (Cmd+K on a Mac) opens the palette. Inside a terminal or remote desktop on other
  // systems the key belongs to the shell or the desktop, so use the search box there instead.
  WS.keyHandler = ev => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 'k') return;
    if (!IS_MAC && ev.target.closest && ev.target.closest('.pane')) return;
    ev.preventDefault();
    ev.stopPropagation();
    const open = document.querySelector('dialog.palette');
    if (open) open.close(); else openPalette();
  };
  document.addEventListener('keydown', WS.keyHandler, true);

  renderWelcome();
  loadIdentities().then(loadHosts).catch(() => {});
  loadCommands().catch(() => {});
}

function destroyWorkspace() {
  for (const t of [...WS.tabs]) closeTab(t);
  if (WS.keyHandler) document.removeEventListener('keydown', WS.keyHandler, true);
  Object.assign(WS, { folders: [], hosts: [], identities: [], tabs: [], active: null, ctrl: false, term: null, ids: null, keyHandler: null, liveKey: '' });
}

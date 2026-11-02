'use strict';

/* RDP panes: a Guacamole client living in a split-pane session.
   Depends on workspace.js (el, setState, showOverlay, scheduleReconnect, ...) and vendor/guacamole-common.js. */

const KEYSYM = { ctrl: [0xFFE3, 0xFFE4], meta: [0xFFE7, 0xFFE8, 0xFFEB, 0xFFEC], v: [0x76, 0x56] };
const DIR_TYPE = 'application/vnd.glyptodon.guacamole.stream-index+json';
const WEB_SESSION_ENDED = 4401;

function newRdpSession(host, wtab) {
  const pane = el('div', 'pane');
  pane.innerHTML = `
    <div class="phead"><span class="dot"></span><span class="pname"></span><span class="grow"></span>
      <button type="button" class="quiet" data-act="kbd" hidden>${icon('keyboard')}Keyboard</button>
      <button type="button" class="quiet" data-act="cad" title="Send Ctrl+Alt+Delete to the remote desktop">Ctrl+Alt+Del</button>
      ${iconButton('clipboard', 'Clipboard', 'data-act="clip"')}
      ${iconButton('files', 'Files', 'data-act="files"')}
      ${iconButton('layout-columns', 'Split right', 'data-act="split-row"')}
      ${iconButton('layout-rows', 'Split down', 'data-act="split-col"')}
      ${iconButton('x', 'Close pane', 'data-act="close"')}</div>
    <div class="rdpwrap">
      <div class="rdpscreen"></div>
      <textarea class="sink" aria-label="Remote desktop keyboard input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="popover clip" hidden>
        <div class="section-head"><h3>Clipboard</h3>${iconButton('x', 'Close', 'data-clip="close"')}</div>
        <p class="small muted">Text copied on the remote desktop shows up here. To paste into it, press Ctrl+V as usual, or type here and send.</p>
        <textarea class="cliptext" rows="5" aria-label="Clipboard text"></textarea>
        <div class="actions"><button type="button" class="primary sm" data-clip="send">Send to remote</button>
          <button type="button" class="sm" data-clip="copy">${icon('copy')}Copy</button></div>
      </div>
      <div class="popover files" hidden>
        <div class="section-head"><h3>Files</h3>${iconButton('x', 'Close', 'data-file="close"')}</div>
        <p class="small muted">Files appear on the remote desktop as the \u201cSwitchboard\u201d drive. They last only as long as this session.</p>
        <input type="file" class="fileinput" multiple aria-label="Choose files to upload">
        <div class="filecrumb small"></div>
        <div class="filelist"></div>
        <p class="small muted filestatus" role="status"></p>
        <div class="actions"><button type="button" class="sm" data-file="refresh">${icon('refresh')}Refresh</button></div>
      </div>
    </div>
    <div class="tover" hidden></div>`;
  const sess = {
    kind: 'rdp', host, wtab, pane, head: pane.querySelector('.phead'),
    holder: pane.querySelector('.rdpwrap'), screen: pane.querySelector('.rdpscreen'), sink: pane.querySelector('.sink'),
    clipPanel: pane.querySelector('.popover.clip'), clipArea: pane.querySelector('.cliptext'),
    filePanel: pane.querySelector('.popover.files'), overlay: pane.querySelector('.tover'),
    client: null, tunnel: null, state: 'connecting', retries: 0, timer: null, closed: false, connectedBefore: false,
    opened: false, fwd: [], fsObj: null, fsPath: '/', ctrlDown: false, pendingPaste: false, suppressV: false,
    sentW: 0, sentH: 0, resizeTimer: null,
  };
  sess.ro = new ResizeObserver(() => requestAnimationFrame(() => fitSess(sess)));
  sess.ro.observe(sess.holder);
  if (matchMedia('(pointer: coarse)').matches) pane.querySelector('[data-act=kbd]').hidden = false;
  // A host can turn the clipboard and file transfer off; the server enforces it too.
  if (!rdpAllows(sess, 'clipboard')) pane.querySelector('[data-act=clip]').hidden = true;
  if (!rdpAllows(sess, 'files')) pane.querySelector('[data-act=files]').hidden = true;

  pane.addEventListener('pointerdown', () => { focusSession(sess); rdpResumeAudio(); }, true);
  pane.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'close': closeSession(sess); break;
      case 'split-row': splitSession(sess, 'row'); break;
      case 'split-col': splitSession(sess, 'col'); break;
      case 'kbd': sess.sink.focus(); break;
      case 'cad': rdpKeys(sess, [0xFFE3, 0xFFE9, 0xFFFF]); break;
      case 'clip': togglePanel(sess, sess.clipPanel, sess.filePanel); b.classList.remove('news'); break;
      case 'files': togglePanel(sess, sess.filePanel, sess.clipPanel); if (!sess.filePanel.hidden) listDir(sess, sess.fsPath); break;
      default: break;
    }
  });
  bindPanels(sess);
  updateHead(sess);
  return sess;
}

function togglePanel(sess, panel, other) {
  other.hidden = true;
  panel.hidden = !panel.hidden;
  if (panel.hidden) sess.sink.focus();
}

function rdpResumeAudio() {
  try { const ctx = Guacamole.AudioContextFactory.getAudioContext(); if (ctx && ctx.state === 'suspended') ctx.resume(); } catch (e) { /* no audio */ }
}

// Press and release keys in order (used for Ctrl+Alt+Del).
function rdpKeys(sess, keysyms) {
  if (!sess.client || sess.state !== 'live') return;
  keysyms.forEach(k => sess.client.sendKeyEvent(1, k));
  [...keysyms].reverse().forEach(k => sess.client.sendKeyEvent(0, k));
  sess.sink.focus();
}

/* ---------- opening and connecting ---------- */

// Called once the pane is in the page. Keyboard and mouse handlers act on whatever client is current.
const rdpAllows = (sess, what) => !sess.host.rdp || sess.host.rdp[what] !== false;

function rdpOpen(sess) {
  if (sess.opened) return;
  sess.opened = true;
  const live = () => sess.client && sess.state === 'live';

  // Every key goes to the remote desktop, so Shift+Escape is the way out for keyboard users.
  sess.sink.setAttribute('aria-label', `Remote desktop for ${sess.host.name}. Press Shift+Escape to leave it.`);
  sess.sink.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && ev.shiftKey) { ev.stopImmediatePropagation(); ev.preventDefault(); sess.head.querySelector('button').focus(); }
  });
  const kbd = new Guacamole.Keyboard(sess.sink);
  sess.kbd = kbd;
  kbd.onkeydown = keysym => {
    if (!live()) return true;
    if (IS_MAC && KEYSYM.meta.includes(keysym)) keysym = KEYSYM.ctrl[0]; // Cmd acts as Ctrl on the remote desktop
    if (KEYSYM.ctrl.includes(keysym)) sess.ctrlDown = true;
    if (KEYSYM.v.includes(keysym) && sess.ctrlDown) {
      // Let the browser's paste event fire first so the remote clipboard is current before it sees Ctrl+V.
      sess.pendingPaste = sess.suppressV = true;
      clearTimeout(sess.pasteTimer);
      sess.pasteTimer = setTimeout(() => finishPaste(sess), 250);
      return true;
    }
    sess.client.sendKeyEvent(1, keysym);
    return false;
  };
  kbd.onkeyup = keysym => {
    if (!live()) return;
    if (IS_MAC && KEYSYM.meta.includes(keysym)) keysym = KEYSYM.ctrl[0];
    if (KEYSYM.ctrl.includes(keysym)) sess.ctrlDown = false;
    if (KEYSYM.v.includes(keysym) && sess.suppressV) { sess.suppressV = false; return; }
    sess.client.sendKeyEvent(0, keysym);
  };
  sess.sink.addEventListener('blur', () => { kbd.reset(); sess.ctrlDown = false; });
  sess.sink.addEventListener('paste', ev => {
    ev.preventDefault();
    const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
    if (text) rdpSendClipboard(sess, text);
    if (sess.pendingPaste) { clearTimeout(sess.pasteTimer); sess.pendingPaste = false; setTimeout(() => rdpChord(sess, 0x76), 80); }
  });
  sess.sink.addEventListener('focus', () => rdpReadLocalClipboard(sess));

  const pointer = e => {
    if (live()) sess.client.sendMouseState(e.state, true);
    if (e.type === 'mousedown') sess.sink.focus({ preventScroll: true });
  };
  // A real click moves focus to the page after the mouse handlers run, so take it back once the
  // click is done. Without this, typing right after clicking the desktop would go nowhere.
  sess.holder.addEventListener('click', ev => {
    if (!ev.target.closest('.popover')) sess.sink.focus({ preventScroll: true });
  });
  const mouse = new Guacamole.Mouse(sess.screen);
  mouse.onEach(['mousedown', 'mouseup', 'mousemove'], pointer);
  const touch = new Guacamole.Mouse.Touchscreen(sess.screen);
  touch.onEach(['mousedown', 'mouseup', 'mousemove'], pointer);

  // Dropping files on the desktop uploads them to the shared drive.
  sess.holder.addEventListener('dragover', ev => { ev.preventDefault(); });
  sess.holder.addEventListener('drop', ev => {
    ev.preventDefault();
    if (rdpAllows(sess, 'files') && ev.dataTransfer && ev.dataTransfer.files.length) { sess.filePanel.hidden = false; sess.clipPanel.hidden = true; uploadFiles(sess, [...ev.dataTransfer.files]); }
  });
}

function finishPaste(sess) {
  sess.pendingPaste = false;
  rdpChord(sess, 0x76);
}

// Press a key while Ctrl is held, pressing Ctrl first if the user has already let go.
function rdpChord(sess, keysym) {
  if (!sess.client || sess.state !== 'live') return;
  if (!sess.ctrlDown) sess.client.sendKeyEvent(1, KEYSYM.ctrl[0]);
  sess.client.sendKeyEvent(1, keysym);
  sess.client.sendKeyEvent(0, keysym);
  if (!sess.ctrlDown) sess.client.sendKeyEvent(0, KEYSYM.ctrl[0]);
}

function rdpConnect(sess) {
  clearTimeout(sess.timer);
  rdpDropClient(sess);
  sess.fwd = [];
  sess.fsObj = null;
  sess.fsPath = '/';
  setState(sess, 'connecting');
  showOverlay(sess, { title: 'Connecting…' });

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/api/ws/rdp/${encodeURIComponent(sess.host.id)}`);
  const client = new Guacamole.Client(tunnel);
  sess.client = client;
  sess.tunnel = tunnel;
  const display = client.getDisplay();
  sess.screen.replaceChildren(display.getElement());
  display.showCursor(false);
  display.oncursor = (canvas, x, y) => { sess.screen.style.cursor = `url(${canvas.toDataURL('image/png')}) ${x} ${y}, auto`; };  // ds-allow: the remote cursor image
  display.onresize = () => rdpScale(sess);

  client.onstatechange = st => {
    if (sess.client !== client || sess.closed) return;
    if (st === Guacamole.Client.State.CONNECTED) {
      if (sess.connectedBefore) { /* the desktop repaints itself; nothing to print */ }
      sess.connectedBefore = true;
      sess.retries = 0;
      hideOverlay(sess);
      setState(sess, 'live');
      rdpFit(sess);
      rdpResumeAudio();
      if (sess.wtab.active === sess && WS.active === sess.wtab) sess.sink.focus();
    } else if (st === Guacamole.Client.State.DISCONNECTED) {
      rdpLost(sess, client, null);
    }
  };
  client.onerror = status => rdpLost(sess, client, status);
  tunnel.onerror = status => rdpLost(sess, client, status);

  client.onclipboard = (stream, mimetype) => {
    if (!/^text\//.test(mimetype)) return;
    const reader = new Guacamole.StringReader(stream);
    let text = '';
    reader.ontext = t => { text += t; };
    reader.onend = () => rdpRemoteClipboard(sess, text);
  };
  client.onfilesystem = obj => {
    sess.fsObj = obj;
    if (!sess.filePanel.hidden) listDir(sess, sess.fsPath);
  };

  // Start at the pane's size so the desktop fits without a resize.
  const w = sess.holder.clientWidth, h = sess.holder.clientHeight;
  const fixed = rdpFixedSize(sess);
  const W = fixed ? fixed.width : w >= 320 ? w - (w % 4) : 1280, H = fixed ? fixed.height : h >= 200 ? h : 720;
  sess.sentW = W;
  sess.sentH = H;
  client.connect(`width=${W}&height=${H}&dpi=96`);
}

function rdpDropClient(sess) {
  const client = sess.client;
  sess.client = null;
  sess.tunnel = null;
  if (client) { try { client.disconnect(); } catch (e) { /* already closed */ } }
}

// The connection ended or failed. status is null for a plain disconnect.
function rdpLost(sess, client, status) {
  if (sess.client !== client || sess.closed || ['fatal', 'ended'].includes(sess.state)) return;
  const code = status ? status.code : 0;
  const message = status && status.message && !/^\d+$/.test(status.message) ? status.message : '';
  const retry = { label: 'Retry', cls: 'primary', fn: () => { sess.retries = 0; connect(sess); } };
  if (code === WEB_SESSION_ENDED) return webSessionEnded(sess);
  const authProblem = code >= 768 && code < 800;
  if (sess.connectedBefore && !authProblem && sess.retries < 8) { scheduleReconnect(sess); return; }
  setState(sess, 'fatal');
  const name = esc(sess.host.name);
  const why = authProblem
    ? 'The remote desktop rejected the username or password. Edit the host and check them.'
    : 'The remote desktop did not answer. Check the address and port, that Remote Desktop is turned on for that PC, and that nothing is blocking the connection.';
  showOverlay(sess, {
    tone: 'danger', title: sess.connectedBefore ? `Connection to ${name} lost` : `Could not connect to ${name}`,
    text: esc(message || why) + (message ? ` ${esc(why)}` : ''), buttons: [retry, closeButton(sess)],
  });
}

function rdpTeardown(sess) {
  sess.closed = true;
  clearTimeout(sess.timer);
  clearTimeout(sess.resizeTimer);
  clearTimeout(sess.pasteTimer);
  sess.ro.disconnect();
  if (sess.kbd) sess.kbd.reset();
  rdpDropClient(sess);
  sess.pane.remove();
}

function rdpFocus(sess) { if (sess.opened && !sess.closed) sess.sink.focus({ preventScroll: true }); }

/* ---------- size and scale ---------- */

// The host's fixed resolution, or null when the desktop follows the window.
function rdpFixedSize(sess) {
  const o = sess.host.rdp;
  return o && o.width > 0 && o.height > 0 ? o : null;
}

function rdpFit(sess) {
  if (!sess.opened || sess.closed) return;
  const w = sess.holder.clientWidth, h = sess.holder.clientHeight;
  if (!w || !h || sess.holder.offsetParent === null) return;
  rdpScale(sess);
  if (!sess.client || sess.state !== 'live' || rdpFixedSize(sess)) return;
  const W = Math.max(320, w - (w % 4)), H = Math.max(200, h);
  if (W === sess.sentW && H === sess.sentH) return;
  // Resize the remote desktop to the pane once the pane stops changing.
  clearTimeout(sess.resizeTimer);
  sess.resizeTimer = setTimeout(() => {
    if (!sess.client || sess.state !== 'live') return;
    sess.sentW = W;
    sess.sentH = H;
    sess.client.sendSize(W, H);
  }, 250);
}

// If the desktop is larger than the pane (a server that won't resize), shrink it to fit.
function rdpScale(sess) {
  if (!sess.client) return;
  const d = sess.client.getDisplay();
  const dw = d.getWidth(), dh = d.getHeight();
  const w = sess.holder.clientWidth, h = sess.holder.clientHeight;
  if (!dw || !dh || !w || !h) return;
  d.scale(Math.min(1, w / dw, h / dh));
}

/* ---------- clipboard ---------- */

function rdpSendClipboard(sess, text) {
  if (!sess.client || sess.state !== 'live') return;
  const writer = new Guacamole.StringWriter(sess.client.createClipboardStream('text/plain'));
  writer.sendText(text);
  writer.sendEnd();
}

function rdpRemoteClipboard(sess, text) {
  sess.clipArea.value = text;
  if (sess.clipPanel.hidden) sess.head.querySelector('[data-act=clip]').classList.add('news');
  // Browsers only allow this on HTTPS; otherwise the text waits in the Clipboard panel.
  try { if (window.isSecureContext && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* not allowed */ }
}

function rdpReadLocalClipboard(sess) {
  try {
    if (!window.isSecureContext || !navigator.clipboard || !navigator.clipboard.readText) return;
    navigator.clipboard.readText().then(text => {
      if (text && text !== sess.lastLocalClip) { sess.lastLocalClip = text; rdpSendClipboard(sess, text); }
    }).catch(() => {});
  } catch (e) { /* not allowed */ }
}

/* ---------- files ---------- */

function bindPanels(sess) {
  const clip = sess.clipPanel;
  clip.addEventListener('click', ev => {
    const b = ev.target.closest('[data-clip]');
    if (!b) return;
    if (b.dataset.clip === 'send') { rdpSendClipboard(sess, sess.clipArea.value); toast('Sent to the remote clipboard'); }
    else if (b.dataset.clip === 'copy') { sess.clipArea.select(); copyText(sess.clipArea.value); }
    else togglePanel(sess, clip, sess.filePanel);
  });
  const files = sess.filePanel;
  files.querySelector('.fileinput').addEventListener('change', ev => {
    uploadFiles(sess, [...ev.target.files]);
    ev.target.value = '';
  });
  files.addEventListener('click', ev => {
    const b = ev.target.closest('[data-file], [data-open]');
    if (!b) return;
    if (b.dataset.file === 'refresh') listDir(sess, sess.fsPath);
    else if (b.dataset.file === 'close') togglePanel(sess, files, sess.clipPanel);
    else if (b.dataset.open) openEntry(sess, b.dataset.open, b.dataset.type);
  });
}

const fileStatus = (sess, text) => { sess.filePanel.querySelector('.filestatus').textContent = text; };
const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;

function listDir(sess, path) {
  const list = sess.filePanel.querySelector('.filelist');
  if (!sess.fsObj) {
    list.innerHTML = '';
    fileStatus(sess, sess.state === 'live' ? 'File transfer is not available on this connection.' : 'Connect first.');
    return;
  }
  fileStatus(sess, '');
  sess.fsObj.requestInputStream(path, (stream, mimetype) => {
    if (mimetype !== DIR_TYPE) { stream.sendAck('Not a folder', Guacamole.Status.Code.CLIENT_BAD_TYPE); return; }
    const reader = new Guacamole.JSONReader(stream);
    reader.onend = () => {
      sess.fsPath = path;
      const entries = Object.entries(reader.getJSON() || {}).sort(([a, ta], [b, tb]) => (tb === DIR_TYPE) - (ta === DIR_TYPE) || a.localeCompare(b));
      sess.filePanel.querySelector('.filecrumb').innerHTML = `${iconButton('arrow-up', 'Up one folder', `data-open="${esc(parentPath(path))}" data-type="${DIR_TYPE}"`)}<code>${esc(path)}</code>`;
      list.innerHTML = entries.length
        ? entries.map(([full, type]) => `<button type="button" class="fentry" data-open="${esc(full)}" data-type="${esc(type)}">${icon(type === DIR_TYPE ? 'folder' : 'files', 'sm')}${esc(full.split('/').pop())}</button>`).join('')
        : '<p class="muted small">Empty. Upload a file to see it on the remote desktop.</p>';
    };
    stream.sendAck('Ready', Guacamole.Status.Code.SUCCESS); // guacd sends nothing until the first ack
  });
}

const parentPath = path => path.replace(/\/[^/]*$/, '') || '/';

function openEntry(sess, path, type) {
  if (type === DIR_TYPE) return listDir(sess, path);
  const name = path.split('/').pop();
  fileStatus(sess, `Downloading ${name}…`);
  sess.fsObj.requestInputStream(path, (stream, mimetype) => {
    const reader = new Guacamole.BlobReader(stream, mimetype);
    reader.onprogress = n => fileStatus(sess, `Downloading ${name}: ${Math.round(n / 1024)} KB`);
    reader.onend = () => {
      const url = URL.createObjectURL(reader.getBlob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      fileStatus(sess, `Downloaded ${name}.`);
    };
    stream.sendAck('Ready', Guacamole.Status.Code.SUCCESS);
  });
}

async function uploadFiles(sess, files) {
  if (!sess.fsObj || sess.state !== 'live') { fileStatus(sess, 'File transfer is not available on this connection.'); return; }
  for (const file of files) {
    try { await uploadOne(sess, file); } catch (e) { fileStatus(sess, `Could not upload ${file.name}: ${e.message}`); return; }
  }
  fileStatus(sess, files.length === 1 ? `Uploaded ${files[0].name}.` : `Uploaded ${files.length} files.`);
  listDir(sess, sess.fsPath);
}

// Sends a file in 4 KB pieces, keeping a bounded number unacknowledged.
async function uploadOne(sess, file) {
  const name = file.name.replace(/[\\/]/g, '_');
  const stream = sess.client.createObjectOutputStream(sess.fsObj.index, file.type || 'application/octet-stream', joinPath(sess.fsPath, name));
  const writer = new Guacamole.ArrayBufferWriter(stream);
  const BLOB = 4096, WINDOW = 32;
  let sent = 0, acked = 0, error = null, wake = null;
  stream.onack = status => {
    acked++;
    if (status.isError()) error = new Error(status.message || 'refused by the remote drive');
    if (wake) { const w = wake; wake = null; w(); }
  };
  const waitFor = cond => new Promise(resolve => {
    const check = () => { if (cond() || error) resolve(); else wake = check; };
    check();
  });
  let offset = 0;
  while (offset < file.size && !error) {
    const buf = await file.slice(offset, offset + 16 * BLOB).arrayBuffer();
    offset += buf.byteLength;
    for (let i = 0; i < buf.byteLength; i += BLOB) { writer.sendData(buf.slice(i, i + BLOB)); sent++; }
    fileStatus(sess, `Uploading ${name}: ${Math.round(100 * offset / file.size)}%`);
    await waitFor(() => sent - acked <= WINDOW);
  }
  await waitFor(() => sent === acked);
  if (error) throw error;
  writer.sendEnd();
}

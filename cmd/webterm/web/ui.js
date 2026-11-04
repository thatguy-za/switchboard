'use strict';

/* Shared building blocks: markup helpers, dialogs, toasts, theme. Loaded before everything else. */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const $q = (root, sel) => root.querySelector(sel);

const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="/icons.svg#i-${name}"/></svg>`;
const iconButton = (name, label, attrs = '', cls = '') =>
  `<button type="button" class="icon ${cls}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;
// The wordmark: lowercase text and a block cursor (DESIGN.md). It only blinks on the sign-in and setup pages.
const logo = ({ blink = false } = {}) =>
  `<span class="logo${blink ? ' blink' : ''}" role="img" aria-label="webterm"><span aria-hidden="true">webterm</span><i class="logo-cursor" aria-hidden="true"></i></span>`;
const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const avatar = name => `<span class="avatar" aria-hidden="true">${esc(String(name).slice(0, 1))}</span>`;

/* ---------- components ----------
   The markup for every component in components.css lives here, so screens never hand-write it.
   The style guide (design.html) renders these same functions. */

const button = (label, { kind = '', icon: ic = '', attrs = '' } = {}) =>
  `<button type="button" class="${kind}" ${attrs}>${ic ? icon(ic) : ''}${esc(label)}</button>`;
const codeBlock = text => `<p class="codeblock">${esc(text)}</p>`;
const codeGrid = codes => `<div class="codes">${codes.map(c => `<span>${esc(c)}</span>`).join('')}</div>`;
const panel = inner => `<div class="panel">${inner}</div>`;
// A password input with an eye button. bindPasswordField wires it up.
const passwordField = ({ name, placeholder = '', autocomplete = 'new-password' }) =>
  `<span class="pwfield"><input type="password" name="${esc(name)}" autocomplete="${esc(autocomplete)}" placeholder="${esc(placeholder)}">${iconButton('eye', 'Show password', 'type="button" data-reveal')}</span>`;

// fetchSaved, when given, returns the stored password (or null) for an empty field.
function bindPasswordField(input, fetchSaved) {
  const btn = input.parentElement.querySelector('[data-reveal]');
  const set = shown => {
    input.type = shown ? 'text' : 'password';
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    btn.querySelector('use').setAttribute('href', `/icons.svg#i-${shown ? 'eye-off' : 'eye'}`);
  };
  btn.addEventListener('click', async () => {
    if (input.type === 'text') return set(false);
    if (!input.value && fetchSaved) {
      const saved = await fetchSaved();
      if (saved === null) return;
      input.value = saved;
    }
    set(true);
    input.focus();
  });
}

const settingRow = (title, desc, control) =>
  `<div class="setting"><div class="what"><div class="title">${title}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="ctl">${control}</div></div>`;
const itemRow = ({ lead = '', title, tags = '', meta = '', actions = '' }) =>
  `<div class="item">${lead}<div class="what"><div class="title">${title}${tags}</div>${meta}</div><div class="acts">${actions}</div></div>`;
const pageHead = (title, sub, actions = '') =>
  `<div class="page-head"><div><h1>${esc(title)}</h1><p class="sub">${sub}</p></div>${actions ? `<div class="row-gap">${actions}</div>` : ''}</div>`;
const sectionHead = (title, actions = '') => `<div class="section-head"><h2>${esc(title)}</h2>${actions}</div>`;
const notice = (iconName, html) => `<div class="notice">${icon(iconName)}<div>${html}</div></div>`;
const emptyState = (title, text, action = '') => `<div class="empty-note"><h2>${esc(title)}</h2><p class="muted">${text}</p>${action}</div>`;
const kbd = text => `<span class="kbd">${esc(text)}</span>`;
// options are [value, label, iconName]; the chosen value is aria-pressed. attr names the data attribute that carries the value.
const segmented = (label, options, value, attr) =>
  `<div class="seg" role="group" aria-label="${esc(label)}">${options.map(([id, text, ic]) =>
    `<button type="button" ${attr}="${esc(id)}" aria-pressed="${id === value}">${ic ? icon(ic) : ''}${esc(text)}</button>`).join('')}</div>`;
const switchControl = ({ id, checked = false, disabled = false, label }) =>
  `<label class="switch"><input type="checkbox" id="${esc(id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"><span></span></label>`;
const checkField = (name, label, hint = '', attrs = '', checked = false) =>
  `<label class="check" ${attrs}><input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''}> ${label}${hint ? `<span class="small">${hint}</span>` : ''}</label>`;
const hostRow = (h, { depth = 0, live = false, kebab = true } = {}) => `
  <div class="row host d${Math.min(depth, 6)}" data-sort-kind="h" data-sort-id="${esc(h.id)}" data-sort-parent="${esc(h.folder_id || '')}" data-sort-depth="${depth}">
    <button type="button" class="row-main" data-sort="h${esc(h.id)}" data-host="${esc(h.id)}" aria-label="Open ${esc(h.name)}${live ? ' (connected)' : ''}">${icon(h.protocol === 'rdp' ? 'device-desktop' : 'terminal-2')}<span class="name">${esc(h.name)}</span>${live ? '<span class="dot live" aria-hidden="true"></span>' : ''}</button>
    ${kebab ? iconButton('dots', `Edit ${h.name}`, `data-edit-host="${esc(h.id)}"`, 'kebab') : ''}
  </div>`;

/* ---------- theme ---------- */

const THEME_KEY = 'wt_theme';
const themeListeners = [];

function themeChoice() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; }
}

// What is actually on screen: 'dark' or 'light'.
function themeEffective() {
  const c = themeChoice();
  return c === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : c;
}

function applyTheme() {
  const c = themeChoice();
  if (c === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', c);
  themeListeners.forEach(fn => fn(themeEffective()));
}

function setThemeChoice(choice) {
  try { localStorage.setItem(THEME_KEY, choice); } catch (e) { /* storage unavailable */ }
  applyTheme();
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themeChoice() === 'system') applyTheme(); });
applyTheme();

// Terminals measure their text when opened, so make sure the fonts are in first.
if (document.fonts) {
  document.fonts.load('400 14px "JetBrains Mono Variable"');
  document.fonts.load('400 13px "Inter Variable"');
}

/* ---------- drag to reorder ----------
   Pointer-driven sorting for the tab strip and the host tree, with Alt+arrow keys as the keyboard way.
   pick(target) says which group the thing under the pointer belongs to, as
   { key, label, group: [{ id, els }], from } where els are the elements that move together (a folder
   moves with the rows inside it), or null when it can't be moved. onMove(ids, picked) gets the group's
   ids in their new order. A mouse starts dragging after a few pixels; touch needs a short press, so
   scrolling still works. */

// A polite, visually hidden message for screen readers.
function announce(text) {
  let box = document.getElementById('sr-live');
  if (!box) {
    box = el('div', 'sr-only');
    box.id = 'sr-live';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  box.textContent = '';
  setTimeout(() => { box.textContent = text; }, 50);
}

function enableSort(container, { pick, onMove, horizontal = false }) {
  const SLOP = 5, HOLD = 350, EDGE = 28;
  const line = el('div', 'drop-line' + (horizontal ? ' h' : ''));
  const side = horizontal ? ['left', 'right', 'clientX'] : ['top', 'bottom', 'clientY'];
  let drag = null;

  const span = els => {
    const rects = els.map(e => e.getBoundingClientRect());
    return [Math.min(...rects.map(r => r[side[0]])), Math.max(...rects.map(r => r[side[1]]))];
  };
  const order = (ids, from, to) => { const out = ids.slice(); out.splice(to, 0, out.splice(from, 1)[0]); return out; };

  const begin = d => {
    d.started = true;
    container.classList.add('sorting');
    d.p.group[d.p.from].els.forEach(e => e.classList.add('sort-lifted'));
    container.appendChild(line);
    window.addEventListener('touchmove', stopScroll, { passive: false });
  };
  const stopScroll = ev => ev.preventDefault();

  const target = ev => {
    const { group, from } = drag.p;
    const pos = ev[side[2]];
    let slot = 0; // the gap the pointer is in: 0 is before the first, group.length after the last
    group.forEach((g, i) => { const [a, b] = span(g.els); if (pos > (a + b) / 2) slot = i + 1; });
    drag.to = slot > from ? slot - 1 : slot;
    const none = drag.to === from;
    line.hidden = none;
    if (!none) {
      const [a, b] = slot === group.length ? [0, span(group[slot - 1].els)[1]] : [span(group[slot].els)[0], 0];
      const at = (slot === group.length ? b : a) - container.getBoundingClientRect()[side[0]] + (horizontal ? container.scrollLeft : container.scrollTop);
      line.style.setProperty('--at', at + 'px'); // ds-allow: the drop marker follows the pointer
    }
    const box = container.getBoundingClientRect();
    if (pos < box[side[0]] + EDGE) container[horizontal ? 'scrollLeft' : 'scrollTop'] -= 12;
    else if (pos > box[side[1]] - EDGE) container[horizontal ? 'scrollLeft' : 'scrollTop'] += 12;
  };

  const finish = apply => {
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    window.removeEventListener('pointermove', onMoveEvent);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('touchmove', stopScroll);
    if (!d.started) return;
    container.classList.remove('sorting');
    d.p.group[d.p.from].els.forEach(e => e.classList.remove('sort-lifted'));
    line.remove();
    // The pointer-up that ends a drag must not also click what is under it.
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (apply && d.to !== d.p.from) {
      const ids = order(d.p.group.map(g => g.id), d.p.from, d.to);
      Promise.resolve(onMove(ids, d.p)).then(() => announce(`${d.p.label} moved to position ${d.to + 1} of ${ids.length}`)).catch(e => toast(e.message, 'err'));
    }
  };

  const onMoveEvent = ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.started) {
      const far = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y);
      if (drag.touch) { if (far > 8) finish(false); return; } // moved before the hold: it is a scroll
      if (far < SLOP) return;
      begin(drag);
    }
    target(ev);
  };
  const onUp = ev => { if (drag && ev.pointerId === drag.id) finish(drag.started); };
  const onCancel = ev => { if (drag && ev.pointerId === drag.id) finish(false); };
  const onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };

  container.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || drag) return;
    const p = pick(ev.target);
    if (!p || p.group.length < 2) return;
    drag = { p, id: ev.pointerId, x: ev.clientX, y: ev.clientY, touch: ev.pointerType === 'touch', started: false, to: p.from, timer: null };
    if (drag.touch) drag.timer = setTimeout(() => { if (drag) begin(drag); }, HOLD);
    window.addEventListener('pointermove', onMoveEvent);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  });

  // Alt plus an arrow key moves the focused item one place.
  container.addEventListener('keydown', async ev => {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 }[ev.key];
    if (!step || (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') !== horizontal) return;
    const p = pick(ev.target);
    if (!p) return;
    ev.preventDefault();
    const to = p.from + step;
    if (to < 0 || to >= p.group.length) return;
    const ids = order(p.group.map(g => g.id), p.from, to);
    try { await onMove(ids, p); } catch (e) { toast(e.message, 'err'); return; }
    const again = container.querySelector(`[data-sort="${p.key}"]`);
    if (again) again.focus();
    announce(`${p.label} moved to position ${to + 1} of ${ids.length}`);
  });
}

/* ---------- toasts ---------- */

function toast(message, kind = '') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = el('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  // One message at a time per text, and no more than three on screen.
  for (const t of [...box.children]) if (t.dataset.msg === message) t.remove();
  while (box.children.length >= 3) box.firstChild.remove();
  const t = el('div', 'toast ' + kind);
  t.dataset.msg = message;
  t.innerHTML = `${icon(kind === 'err' ? 'alert-triangle' : 'circle-check')}<span>${esc(message)}</span>`;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, kind === 'err' ? 5000 : 2600);
}

function copyText(text, label = 'Copied') {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(label), () => toast('Copy failed', 'err'));
  else toast('Copy is not available here', 'err');
}

/* ---------- dialogs ---------- */

// A modal form. onSubmit gets the FormData and the dialog; throwing keeps it open and shows the message.
let dialogSeq = 0;
function dialog(title, body, { onSubmit, submitLabel = 'Save', extra = '', actions = '', wide = false, description = '' } = {}) {
  const d = el('dialog', wide ? 'wide' : '');
  const titleId = 'dlg-title-' + (++dialogSeq);
  d.setAttribute('aria-labelledby', titleId);
  d.innerHTML = `<form class="dlg">
    <div class="dlg-head"><h2 id="${titleId}">${esc(title)}</h2>${iconButton('x', 'Close', 'data-cancel')}</div>
    <div class="dlg-body">${description ? `<p class="muted">${description}</p>` : ''}${body}</div>
    <div class="dlg-foot"><span class="err" role="alert"></span>${extra ? `<span class="left">${extra}</span>` : ''}
      ${onSubmit ? '<button type="button" class="quiet" data-cancel>Cancel</button>' : ''}
      ${onSubmit ? `<button class="primary">${esc(submitLabel)}</button>` : `<button type="button" class="${actions ? 'quiet' : ''}" data-cancel>${actions ? 'Close' : 'Done'}</button>${actions}`}</div>
  </form>`;
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
  const first = d.querySelector('.dlg-body input:not([type=hidden]):not([type=checkbox]), .dlg-body select, .dlg-body textarea');
  if (first) first.focus();
  return d;
}

// Ask for the account password before a sensitive action. done(password) may throw to show an error.
function passwordDialog(title, description, submitLabel, done) {
  return dialog(title, `<label>Your password<input type="password" name="password" required autocomplete="current-password"></label>`,
    { description, submitLabel, onSubmit: fd => done(fd.get('password')) });
}

function confirmDialog(title, description, confirmLabel, onConfirm, danger = true) {
  const d = dialog(title, '', { description, submitLabel: confirmLabel, onSubmit: () => onConfirm() });
  if (danger) d.querySelector('button.primary').classList.add('danger', 'solid');
  d.querySelector('button.primary').classList.remove('primary');
  return d;
}

/* ---------- terminal colours ----------
   xterm needs plain colour strings, so read the --term-* tokens for a palette and resolve them. */

let termThemes = {};
themeListeners.push(() => { termThemes = {}; });

function resolveColor(value) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
}

// name is 'dark', 'light', 'contrast' or 'auto' (which follows the app theme).
function xtermTheme(name) {
  if (name === 'auto') name = 'dark'; // terminals stay dark by default, in both app themes
  if (termThemes[name]) return termThemes[name];
  const probe = el('div');
  probe.dataset.term = name;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const read = key => resolveColor(cs.getPropertyValue('--term-' + key).trim());
  const t = { background: read('bg'), foreground: read('fg'), cursor: read('cursor'), selectionBackground: read('selection') };
  for (const c of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    t[c] = read(c);
    t['bright' + c[0].toUpperCase() + c.slice(1)] = read('bright-' + c);
  }
  probe.remove();
  termThemes[name] = t;
  return t;
}

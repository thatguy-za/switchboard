'use strict';

/* Shared building blocks: markup helpers, dialogs, toasts, theme. Loaded before everything else. */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const $q = (root, sel) => root.querySelector(sel);

const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="/icons.svg#i-${name}"/></svg>`;
const iconButton = (name, label, attrs = '', cls = '') =>
  `<button type="button" class="icon ${cls}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;
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
const checkField = (name, label, hint = '', attrs = '') =>
  `<label class="check" ${attrs}><input type="checkbox" name="${esc(name)}"> ${label}${hint ? `<span class="small">${hint}</span>` : ''}</label>`;
const hostRow = (h, { depth = 0, live = false, kebab = true } = {}) => `
  <div class="row host d${Math.min(depth, 6)}" tabindex="0" role="button" data-host="${esc(h.id)}" aria-label="Open ${esc(h.name)}">
    ${icon(h.protocol === 'rdp' ? 'device-desktop' : 'terminal-2')}<span class="name">${esc(h.name)}</span>${live ? '<span class="dot live" title="Connected"></span>' : ''}
    ${kebab ? iconButton('dots', `Edit ${h.name}`, `data-edit-host="${esc(h.id)}"`, 'kebab') : ''}
  </div>`;

/* ---------- theme ---------- */

const THEME_KEY = 'sb_theme';
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
function dialog(title, body, { onSubmit, submitLabel = 'Save', extra = '', wide = false, description = '' } = {}) {
  const d = el('dialog', wide ? 'wide' : '');
  d.innerHTML = `<form class="dlg">
    <div class="dlg-head"><h2>${esc(title)}</h2>${iconButton('x', 'Close', 'data-cancel')}</div>
    <div class="dlg-body">${description ? `<p class="muted">${description}</p>` : ''}${body}</div>
    <div class="dlg-foot"><span class="err"></span>${extra ? `<span class="left">${extra}</span>` : ''}
      ${onSubmit ? '<button type="button" class="quiet" data-cancel>Cancel</button>' : ''}
      ${onSubmit ? `<button class="primary">${esc(submitLabel)}</button>` : '<button type="button" data-cancel>Done</button>'}</div>
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
  if (name === 'auto') name = themeEffective();
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

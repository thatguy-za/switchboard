'use strict';

/* Shared building blocks: markup helpers, dialogs, toasts, theme. Loaded before everything else. */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const $q = (root, sel) => root.querySelector(sel);

const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const iconButton = (name, label, attrs = '', cls = '') =>
  `<button type="button" class="icon ${cls}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;
const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const avatar = name => `<span class="avatar" aria-hidden="true">${esc(String(name).slice(0, 1))}</span>`;

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

'use strict';

/* The style guide. It reads the real token file and draws every component with the same builders the app uses,
   so what you see here is what ships. Every @component in css/components.css must have an entry in COMPONENTS. */

const guide = document.getElementById('guide');

/* ---------- tokens ---------- */

function declaredTokens() {
  const sheet = [...document.styleSheets].find(s => s.href && s.href.endsWith('/css/tokens.css'));
  const names = [];
  for (const rule of sheet ? sheet.cssRules : []) {
    if (rule.selectorText !== ':root') continue;
    for (const name of rule.style) if (name.startsWith('--') && !names.includes(name)) names.push(name);
  }
  return names;
}

const SEMANTIC = /^--(bg|surface-|line|text|acc|danger|warn|on-|overlay|shadow-|focus-ring|switch-knob|qr-bg|desktop-bg)/;
const PALETTE = /^--(ink|paper|green|red|amber|black|white)/;

// Elements built with data-vars get their custom properties set here, once, after drawing.
function applyVars(root) {
  root.querySelectorAll('[data-vars]').forEach(e => {
    const vars = JSON.parse(e.dataset.vars);
    for (const k of Object.keys(vars)) e.style.setProperty(k, vars[k]); // ds-allow: per-token sample values
  });
}

const swatches = names => `<div class="swatches">${names.map(n =>
  `<div class="swatch"><div class="chip" data-vars='${esc(JSON.stringify({ '--swatch': `var(${n})` }))}'></div><code>${esc(n)}</code></div>`).join('')}</div>`;

const scaleRows = (names, kind) => `<div class="scale">${names.map(n => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return `<div class="scale-row"><code>${esc(n)}</code><span>${esc(v)}</span>${kind === 'bar' ? `<div class="scale-bar" data-vars='${esc(JSON.stringify({ '--bar': `var(${n})` }))}'></div>` : ''}</div>`;
}).join('')}</div>`;

function foundations() {
  const all = declaredTokens();
  const semantic = all.filter(n => SEMANTIC.test(n) && !/^--(shadow-ink|overlay-ink|shadow-lg|focus-ring)$/.test(n));
  const palette = all.filter(n => PALETTE.test(n));
  const space = all.filter(n => /^--s-\d+$/.test(n));
  const fs = all.filter(n => /^--fs-/.test(n));
  const radii = all.filter(n => /^--r-/.test(n));
  const motion = all.filter(n => /^--(dur|ease)-/.test(n));
  const sizes = all.filter(n => /^--(h|w|icon|size)-/.test(n));
  return [
    ['colour-semantic', 'Colour, by purpose', 'What a colour is for. These change with the theme; components only ever use these.', `<div class="stage column">${swatches(semantic)}</div>`],
    ['colour-palette', 'Colour, palette', 'The raw palette. Only tokens.css refers to these directly.', `<div class="stage column">${swatches(palette)}</div>`],
    ['type', 'Type', 'Inter for the interface, JetBrains Mono for code, keys and terminals. Two weights do most of the work.', `<div class="stage column">
      <div class="type-sample"><span>h1</span><h1>Open a host, or add your first</h1></div>
      <div class="type-sample"><span>h2</span><h2>Two-factor authentication</h2></div>
      <div class="type-sample"><span>body</span><span>Switchboard keeps every secret encrypted in your vault.</span></div>
      <div class="type-sample"><span>small</span><span class="small muted">Saved in this browser. Colours are set per host.</span></div>
      <div class="type-sample"><span>mono</span><code>SHA256:mC975tQziF3cxTXwTnHDb4xK3pJofQcLnwL5EbZIicE</code></div>
      ${scaleRows(fs, 'size')}</div>`],
    ['space', 'Space', 'A 2px grid. Padding, gaps and margins use these and nothing else.', `<div class="stage column">${scaleRows(space, 'bar')}</div>`],
    ['radius', 'Radius', 'Corners step up with the size of the thing.', `<div class="stage">${radii.map(n =>
      `<div class="radius-box" data-vars='${esc(JSON.stringify({ '--radius': `var(${n})` }))}'>${esc(n.replace('--r-', ''))}</div>`).join('')}
      <div class="shadow-box">shadow-lg</div></div>`],
    ['motion', 'Motion', 'Short and quiet. All of it stops when the system asks for reduced motion.', `<div class="stage column">${scaleRows(motion, 'size')}</div>`],
    ['sizes', 'Sizes', 'Component dimensions: control heights, icon sizes, widths.', `<div class="stage column">${scaleRows(sizes, 'size')}</div>`],
  ];
}

/* ---------- components ---------- */

const hostSample = { id: 'x', name: 'pi-hole', protocol: 'ssh' };
const rdpSample = { id: 'y', name: 'media pc', protocol: 'rdp' };

const COMPONENTS = [
  { id: 'icon', name: 'Icon', description: 'One outline set (Tabler, MIT), drawn from icons.svg. Always paired with text or a label.',
    render: () => `<div class="stage">${icon('terminal-2', 'sm')}${icon('terminal-2')}${icon('terminal-2', 'lg')}${icon('logo', 'mark')}</div>` },
  { id: 'button', name: 'Button', description: 'Secondary by default. At most one primary per view. Danger is for things that destroy data.',
    render: () => `<div class="stage">${button('Cancel')}${button('Save', { kind: 'primary' })}${button('Not now', { kind: 'quiet' })}${button('Turn off', { kind: 'danger' })}
      ${button('Delete user', { kind: 'danger solid' })}${button('Add user', { kind: 'primary', icon: 'plus' })}${button('Small', { kind: 'sm' })}${button('Disabled', { attrs: 'disabled' })}</div>
      <div class="stage">${button('Full width', { kind: 'primary block' })}</div>` },
  { id: 'icon-button', name: 'Icon button', description: 'For repeated actions in tight spaces. Always has an accessible name and a tooltip.',
    render: () => `<div class="stage">${iconButton('copy', 'Copy')}${iconButton('download', 'Download')}${iconButton('trash', 'Delete')}${iconButton('x', 'Close', '', 'sm')}</div>` },
  { id: 'field', name: 'Field', description: 'A label above its control. Inputs, selects and text areas share one look.',
    render: () => `<div class="stage column"><label>Name<input type="text" value="pi-hole"></label>
      <label>Type<select><option>SSH</option><option>Desktop (RDP)</option></select></label>
      <label>Private key<textarea rows="3" class="mono">-----BEGIN OPENSSH PRIVATE KEY-----</textarea></label>
      <label>Files<input type="file"></label><p class="err">That password is not long enough.</p></div>` },
  { id: 'check', name: 'Checkbox', description: 'For choices that apply on save. A hint sits under the label.',
    render: () => `<div class="stage column">${checkField('a', 'Accept self-signed certificates', 'Windows PCs usually have one.')}${checkField('b', 'I have stored this key somewhere safe')}</div>` },
  { id: 'switch', name: 'Switch', description: 'For settings that take effect straight away.',
    render: () => `<div class="stage">${switchControl({ id: 's1', checked: true, label: 'On' })}${switchControl({ id: 's2', label: 'Off' })}${switchControl({ id: 's3', checked: true, disabled: true, label: 'Disabled' })}</div>` },
  { id: 'segmented', name: 'Segmented control', description: 'Two to four mutually exclusive options that apply immediately.',
    render: () => `<div class="stage">${segmented('Theme', [['system', 'System', 'device-laptop'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], 'dark', 'data-demo')}</div>` },
  { id: 'tag', name: 'Tag', description: 'Short status words. Colour only when it carries meaning.',
    render: () => `<div class="stage">${tag('Member')}${tag('Admin', 'acc')}${tag('Temporary password', 'warn')}</div>` },
  { id: 'kbd', name: 'Keyboard hint', description: 'Shows a shortcut.', render: () => `<div class="stage">${kbd('Ctrl K')}${kbd('Esc')}</div>` },
  { id: 'avatar', name: 'Avatar', description: 'The first letter of a name.', render: () => `<div class="stage">${avatar('owner')}${avatar('kim')}</div>` },
  { id: 'dot', name: 'Status dot', description: 'Connection state. Green is live, amber is working, red failed.',
    render: () => `<div class="stage">${['live', 'connecting', 'lost', 'hostkey', 'fatal', 'ended'].map(s => `<span class="row-gap"><span class="dot ${s}"></span><span class="small muted">${s}</span></span>`).join('')}</div>` },
  { id: 'code-block', name: 'Code block', description: 'For fingerprints, keys and backup codes. Selects in one click.',
    render: () => `<div class="stage column">${codeBlock('SHA256:mC975tQziF3cxTXwTnHDb4xK3pJofQcLnwL5EbZIicE')}${codeGrid(['4k2q-9xv7', 'm8c3-hd2p', 'j5ra-2nw8', 'x7te-6bq4'])}</div>` },
  { id: 'dialog', name: 'Dialog', description: 'A modal form with a title, a body and a footer. Errors appear in the footer, beside the actions.',
    render: () => `<div class="stage tall"><dialog open><form class="dlg"><div class="dlg-head"><h2>Add a user</h2>${iconButton('x', 'Close')}</div>
      <div class="dlg-body"><p class="muted">They will be asked to choose their own password the first time they sign in.</p>
      <label>Username<input type="text" value="kim"></label><label>Role<select><option>Member</option><option>Admin</option></select></label></div>
      <div class="dlg-foot"><span class="err"></span><button type="button" class="quiet">Cancel</button><button class="primary">Add user</button></div></form></dialog></div>` },
  { id: 'palette', name: 'Command palette', description: 'Search hosts, run actions, or type user@host. Opens with Ctrl K, or Cmd K on a Mac.',
    render: () => `<div class="stage tall"><dialog open class="palette"><div class="pal-input">${icon('search')}<input type="text" placeholder="Search hosts, or type user@host to connect"></div>
      <div class="pal-list"><div class="pal-group">Hosts</div>
      <div class="pal-row on">${icon('terminal-2')}<span>pi-hole</span><span class="hint">Home lab</span></div>
      <div class="pal-row">${icon('device-desktop')}<span>media pc</span><span class="hint">Home lab</span></div>
      <div class="pal-group">Actions</div><div class="pal-row">${icon('plus')}<span>New host</span></div></div></dialog></div>` },
  { id: 'toast', name: 'Toast', description: 'Confirms something that already happened. Gone in a couple of seconds.',
    render: () => `<div class="stage"><div class="toast">${icon('circle-check')}<span>Host saved</span></div><div class="toast err">${icon('alert-triangle')}<span>Copy failed</span></div></div>` },
  { id: 'popover', name: 'Popover', description: 'A small panel that floats over a pane: the clipboard, files, forwards.',
    render: () => `<div class="stage tall"><div class="popover"><div class="section-head"><h3>Clipboard</h3>${iconButton('x', 'Close')}</div>
      <p class="small muted">Text copied on the remote desktop shows up here.</p><textarea rows="3"></textarea>
      <div class="actions">${button('Send to remote', { kind: 'primary sm' })}${button('Copy', { kind: 'sm', icon: 'copy' })}</div></div></div>` },
  { id: 'overlay-box', name: 'Pane overlay', description: 'Says what a pane is doing, or asks a question before it continues.',
    render: () => `<div class="stage flush"><div class="tover"><div class="tbox danger"><div class="title">${icon('alert-triangle')}The host key for pi-hole has changed</div>
      <div class="text">Someone may be intercepting this connection, or the server was reinstalled.<span class="fp-label">Saved</span><code class="fp">SHA256:Z7JhYC7mEL0hweX4QShWW8HB4MXMQ26IyP6Ql9x52a8</code></div>
      <div class="actions">${button('Disconnect', { kind: 'primary' })}${button('Accept new key', { kind: 'danger' })}</div></div></div></div>` },
  { id: 'tabs', name: 'Tabs', description: 'Open sessions. The active tab joins the terminal beneath it.',
    render: () => `<div class="stage flush"><div class="tabs"><div class="tab on"><button class="tab-main" type="button">${icon('terminal-2')}<span class="label">pi-hole</span><span class="dot live"></span></button>${iconButton('x', 'Close', '', 'tab-x')}</div>
      <div class="tab"><button class="tab-main" type="button">${icon('device-desktop')}<span class="label">media pc <span class="faint">+1</span></span><span class="dot connecting"></span></button>${iconButton('x', 'Close', '', 'tab-x')}</div>${iconButton('plus', 'Open a host', '', 'plus')}</div></div>` },
  { id: 'nav', name: 'Navigation', description: 'Sidebar links and the settings sub-navigation. The current page is marked with aria-current.',
    render: () => `<div class="stage column"><button class="nav" type="button">${icon('key')}Identities</button><button class="nav" type="button" aria-current="page">${icon('settings')}Settings<span class="badge"></span></button>
      <nav class="subnav"><button type="button" aria-current="page">${icon('user')}Account</button><button type="button">${icon('shield-lock')}Security</button></nav></div>` },
  { id: 'tree-row', name: 'Host row', description: 'A host or folder in the sidebar. Edit appears on hover, and always on touch screens.',
    render: () => `<div class="stage column"><div class="row folder" aria-expanded="true">${icon('chevron-down', 'chev sm')}<span class="name">Home lab</span></div>
      ${hostRow(hostSample, { depth: 1, live: true })}${hostRow(rdpSample, { depth: 1 })}</div>` },
  { id: 'panel', name: 'Panel', description: 'A bordered container for related rows.',
    render: () => `<div class="stage column">${panel(settingRow('Password', 'Changing it keeps your vault readable.', button('Change password')) + settingRow('Theme', 'Follows your system.', button('Dark')))}</div>` },
  { id: 'setting', name: 'Setting row', description: 'A title and description on the left, the control on the right.',
    render: () => `<div class="stage column">${panel(settingRow('Require two-factor authentication', 'Everyone must set it up the next time they sign in.', switchControl({ id: 'st1', label: 'Require' })))}</div>` },
  { id: 'item', name: 'List item', description: 'One thing in a list, with tags, a line of detail and actions.',
    render: () => `<div class="stage column">${panel(itemRow({ lead: icon('key', 'lg faint'), title: 'Key 2026-11', tags: tag('Ed25519'),
      meta: '<div class="meta mono">SHA256:mC975tQziF3cxTXwTnHDb4xK</div><div class="meta">Pushed to pi-hole</div>',
      actions: button('Push to hosts', { kind: 'sm', icon: 'send' }) + iconButton('copy', 'Copy') + iconButton('trash', 'Delete') }))}</div>` },
  { id: 'notice', name: 'Notice', description: 'Something to do, not an error. Used sparingly.',
    render: () => `<div class="stage column">${notice('alert-triangle', '<strong>Back up the master key.</strong><div class="muted">If it is lost, no vault can be opened.</div>')}</div>` },
  { id: 'empty-state', name: 'Empty state', description: 'Says what the space is for and how to fill it.',
    render: () => `<div class="stage column">${panel(emptyState('No identities yet', 'Create one, then push it to your servers to sign in without a password.', button('New identity', { kind: 'primary', icon: 'plus' })))}</div>` },
  { id: 'page-head', name: 'Page header', description: 'A title, one line of context, and the page’s actions.',
    render: () => `<div class="stage column">${pageHead('Identities', 'SSH key pairs, encrypted in your vault.', button('Import key', { icon: 'upload' }) + button('New identity', { kind: 'primary', icon: 'plus' }))}</div>` },
];

/* ---------- page ---------- */

async function drawGuide() {
  const found = foundations();
  const sprite = await fetch('/icons.svg').then(r => r.text()).catch(() => '');
  const iconNames = [...sprite.matchAll(/id="i-([a-z0-9-]+)"/g)].map(m => m[1]).filter(n => n !== 'logo');

  const section = (id, title, desc, body) => `<section id="${id}"><div><h2>${esc(title)}</h2><p class="desc">${desc}</p></div>${body}</section>`;
  const sections = [
    ...found.map(([id, title, desc, body]) => section(id, title, desc, body)),
    section('icons', 'Icons', 'Every icon in icons.svg.', `<div class="stage column"><div class="icon-grid">${iconNames.map(n =>
      `<div class="icon-cell">${icon(n, 'lg')}<span>${esc(n)}</span></div>`).join('')}</div></div>`),
    ...COMPONENTS.map(c => section('c-' + c.id, c.name, esc(c.description), c.render())),
  ];
  const nav = `<div class="group">Foundations</div>${found.map(f => `<a href="#${f[0]}">${esc(f[1])}</a>`).join('')}<a href="#icons">Icons</a>
    <div class="group">Components</div>${COMPONENTS.map(c => `<a href="#c-${c.id}">${esc(c.name)}</a>`).join('')}`;

  guide.innerHTML = `<div class="guide"><nav class="guide-nav" aria-label="Design system">${nav}</nav><main class="guide-main">
    <div class="guide-top"><div><h1>Design system</h1><p class="desc">Tokens and components for Switchboard. Everything here is drawn from the same files the app uses.</p></div>
      ${segmented('Theme', [['system', 'System', 'device-laptop'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], themeChoice(), 'data-theme')}</div>
    ${sections.join('')}</main></div>`;
  applyVars(guide);
  guide.querySelector('.guide-top .seg').addEventListener('click', ev => {
    const b = ev.target.closest('[data-theme]');
    if (!b) return;
    setThemeChoice(b.dataset.theme);
    guide.querySelectorAll('.guide-top .seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
}

drawGuide();

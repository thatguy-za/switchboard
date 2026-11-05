/* ---------- Proxmox ----------
   Connect a Proxmox server in Settings, see its VMs and containers on their own page, start, shut
   down, reboot or stop them, and link hosts to the VM they run on. The server does the talking:
   the token secret never reaches the browser. */

const PVE = { servers: [], vms: [], problems: [], loaded: false };

async function loadProxmoxServers() {
  PVE.servers = await api('GET', '/proxmox/servers');
  const nav = shell && $('#nav-proxmox', shell);
  if (nav) nav.hidden = !PVE.servers.length;
}

const pveKey = vm => `${vm.server_id}/${vm.type}/${vm.vmid}`;
const pveKind = type => (type === 'lxc' ? 'CT' : 'VM');

function formatUptime(seconds) {
  if (!seconds) return '';
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds / 3600) % 24, m = Math.floor(seconds / 60) % 60;
  return d ? `${d} day${d === 1 ? '' : 's'}` : h ? `${h} h` : `${m} min`;
}

async function loadProxmoxVMs() {
  const r = await api('GET', '/proxmox/vms');
  PVE.vms = r.vms;
  PVE.problems = r.errors;
  PVE.loaded = true;
}

/* ---- the Proxmox page ---- */

async function renderProxmoxPage() {
  const root = shell && $('#view-proxmox', shell);
  if (!root) return;
  if (!PVE.loaded) root.innerHTML = `<div class="page"><div class="page-in">${pageHead('Proxmox', 'Loading your virtual machines…')}</div></div>`;
  try { await loadProxmoxVMs(); } catch (e) { PVE.problems = [{ server: '', message: e.message }]; }
  drawProxmoxPage(root);
}

function drawProxmoxPage(root) {
  const running = PVE.vms.filter(v => v.status === 'running').length;
  const several = PVE.servers.length > 1;
  const row = vm => {
    const on = vm.status === 'running';
    const state = on ? `Running${vm.uptime ? ' · ' + formatUptime(vm.uptime) : ''}` : vm.status === 'stopped' ? 'Stopped' : vm.status[0].toUpperCase() + vm.status.slice(1);
    return itemRow({
      lead: `<span class="dot ${on ? 'live' : ''}" role="img" aria-label="${on ? 'Running' : 'Not running'}"></span>`,
      title: esc(vm.name),
      tags: `${tag(pveKind(vm.type) + ' ' + vm.vmid)}${vm.host_name ? tag(vm.host_name, 'acc') : ''}`,
      meta: `<div class="meta">${esc(state)} · ${esc(vm.node)}${several ? ' · ' + esc(vm.server) : ''}</div>`,
      actions: on
        ? `${iconButton('refresh', `Reboot ${vm.name}`, `data-pve="reboot" data-key="${esc(pveKey(vm))}"`)}${button('Shut down', { kind: 'sm', icon: 'power', attrs: `data-pve="shutdown" data-key="${esc(pveKey(vm))}" aria-label="Shut down ${esc(vm.name)}"` })}${iconButton('player-stop', `Stop ${vm.name} (cuts the power)`, `data-pve="stop" data-key="${esc(pveKey(vm))}"`, 'danger')}`
        : button('Start', { kind: 'primary sm', icon: 'player-play', attrs: `data-pve="start" data-key="${esc(pveKey(vm))}" aria-label="Start ${esc(vm.name)}"` }),
    });
  };
  const problems = PVE.problems.map(p => notice('alert-triangle', `<strong>${esc(p.server || 'Proxmox')}</strong><div class="muted">${esc(p.message)}</div>`)).join('');
  root.innerHTML = `<div class="page"><div class="page-in">
    ${pageHead('Proxmox', PVE.vms.length ? `${running} of ${PVE.vms.length} running` : 'Your virtual machines and containers.', button('Refresh', { icon: 'refresh', attrs: 'id="pve-refresh"' }))}
    <div class="stack">${problems}
    ${PVE.vms.length ? panel(PVE.vms.map(row).join('')) : (PVE.problems.length ? '' : emptyState('No virtual machines', 'This token can not see any. Give it the VM.Audit permission in Proxmox.'))}</div>
  </div></div>`;
  $('#pve-refresh', root).addEventListener('click', renderProxmoxPage);
  root.querySelectorAll('[data-pve]').forEach(b => b.addEventListener('click', () => {
    const vm = PVE.vms.find(v => pveKey(v) === b.dataset.key);
    if (vm) pveAction(vm, b.dataset.pve);
  }));
}

// The three that interrupt the guest ask first; start just goes.
const PVE_ASK = {
  shutdown: (n) => [`Shut down ${n}?`, 'Asks the guest to shut down cleanly, like pressing the power button once.', 'Shut down', false],
  reboot: (n) => [`Reboot ${n}?`, 'Asks the guest to restart. Anything that is not saved may be lost.', 'Reboot', false],
  stop: (n) => [`Stop ${n}?`, 'This cuts the power straight away, like pulling the plug. Unsaved work in it is lost. Use Shut down unless it is stuck.', 'Stop', true],
};
const PVE_DONE = { start: 'Starting', shutdown: 'Shutting down', reboot: 'Rebooting', stop: 'Stopping' };

async function pveSend(vm, action) {
  await api('POST', `/proxmox/servers/${vm.server_id}/${vm.type}/${vm.vmid}/${action}`);
  toast(`${PVE_DONE[action]} ${vm.name}`);
}

function pveAction(vm, action, done) {
  const go = async () => {
    await pveSend(vm, action);
    // The VM takes a moment to change state, so look again twice.
    for (const wait of [1500, 5000]) setTimeout(() => { if (shell && !$('#view-proxmox', shell).hidden) renderProxmoxPage(); if (done) done(); }, wait);
  };
  if (!PVE_ASK[action]) return go().catch(e => toast(e.message, 'err'));
  const [title, text, label, danger] = PVE_ASK[action](vm.name);
  confirmDialog(title, text, label, go, danger);
}

/* ---- Settings: connect servers ---- */

async function renderProxmoxSettings(host) {
  try { await loadProxmoxServers(); } catch (e) { host.innerHTML = notice('alert-triangle', esc(e.message)); return; }
  const rows = PVE.servers.map(p => itemRow({
    title: esc(p.address.replace('https://', '')),
    meta: `<div class="meta">Token <code>${esc(p.token_id)}</code></div><div class="meta">Certificate <code>${esc(p.fingerprint.slice(0, 23))}…</code></div>`,
    actions: button('Remove', { kind: 'sm danger', attrs: `data-pve-remove="${esc(p.id)}"` }),
  })).join('');
  host.innerHTML = `
    ${panel(settingRow('Proxmox', 'Start, shut down and reboot your virtual machines and containers, and open a host after starting the VM it runs on.',
      button('Add server', { kind: 'primary', icon: 'plus', attrs: 'id="pve-add"' })))}
    ${PVE.servers.length ? sectionHead('Connected servers') + panel(rows) : ''}
    <p class="small muted"><strong>Use a token with only the permissions it needs.</strong> In Proxmox, open Datacenter, Permissions, API Tokens and add one for WebTerm, with <em>Privilege Separation</em> on. Give it the <code>PVEVMUser</code> role on the VMs you want to control. The secret is shown once, and is stored encrypted in your vault.</p>`;
  $('#pve-add', host).addEventListener('click', () => proxmoxAddressDialog(() => renderProxmoxSettings(host)));
  host.querySelectorAll('[data-pve-remove]').forEach(b => b.addEventListener('click', () => {
    const p = PVE.servers.find(x => x.id === b.dataset.pveRemove);
    confirmDialog(`Remove ${p.address.replace('https://', '')}?`, 'Hosts linked to its VMs are unlinked. Nothing changes on the Proxmox server.', 'Remove', async () => {
      await api('DELETE', '/proxmox/servers/' + p.id);
      PVE.loaded = false;
      await renderProxmoxSettings(host);
      toast('Server removed');
    });
  }));
}

// Step one asks where the server is, and shows the certificate it presents.
function proxmoxAddressDialog(done) {
  dialog('Connect to Proxmox', `<label>Server address<input type="text" name="address" placeholder="https://pve.lan:8006" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>`, {
    description: 'The address of the Proxmox web interface. WebTerm shows its certificate next, so you can check it before it is trusted.',
    submitLabel: 'Check certificate',
    onSubmit: async fd => {
      const address = String(fd.get('address')).trim();
      const r = await api('POST', '/proxmox/probe', { address });
      setTimeout(() => proxmoxTrustDialog(address, r.fingerprint, done), 0);
    },
  });
}

// Step two pins that certificate and checks the token against the server.
function proxmoxTrustDialog(address, fingerprint, done) {
  const d = dialog('Trust this certificate', `
    <div class="fp-label">${esc(address.replace('https://', ''))}</div><code class="fp">${esc(fingerprint)}</code>
    <label>Token ID<input type="text" name="token_id" placeholder="webterm@pve!power" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
    <label>Token secret${passwordField({ name: 'secret', placeholder: 'Paste the secret' })}</label>`, {
    description: 'Check that this fingerprint matches your Proxmox server. WebTerm only talks to a server that presents exactly this certificate, and warns you if it ever changes.',
    submitLabel: 'Trust and connect',
    onSubmit: async fd => {
      await api('POST', '/proxmox/servers', { address, token_id: String(fd.get('token_id')).trim(), secret: String(fd.get('secret')).trim(), fingerprint });
      PVE.loaded = false;
      await loadProxmoxServers();
      toast('Proxmox connected');
      if (done) done();
    },
  });
  bindPasswordField(d.querySelector('input[name=secret]'));
}

/* ---- the host dialog: link a host to its VM ---- */

// Adds the Proxmox VM chooser, a suggestion, and the power buttons to an open host dialog.
async function bindProxmoxField(d, host) {
  const sel = d.querySelector('select[name=pve]');
  const note = d.querySelector('#pve-note');
  if (!sel) return;
  const current = host && host.proxmox ? `${host.proxmox.server_id}|${host.proxmox.type}|${host.proxmox.vmid}` : '';
  let vms = [];
  try { await loadProxmoxVMs(); vms = PVE.vms; } catch (e) { note.textContent = e.message; }
  const label = vm => `${vm.name} (${pveKind(vm.type)} ${vm.vmid})${PVE.servers.length > 1 ? ' · ' + vm.server : ''}${vm.host_name && vm.host_name !== (host && host.name) ? ', linked to ' + vm.host_name : ''}`;
  sel.innerHTML = `<option value="">None</option>` + vms.map(vm => {
    const v = `${vm.server_id}|${vm.type}|${vm.vmid}`;
    return `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label(vm))}</option>`;
  }).join('');
  if (current && !vms.some(vm => `${vm.server_id}|${vm.type}|${vm.vmid}` === current)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(current)}" selected>VM ${host.proxmox.vmid} (not found right now)</option>`);
  }
  const power = d.querySelector('#pve-power');
  const drawPower = () => {
    const vm = vms.find(x => `${x.server_id}|${x.type}|${x.vmid}` === sel.value);
    power.innerHTML = vm ? `<span class="small muted">${esc(vm.name)} is ${vm.status === 'running' ? 'running' : 'not running'}.</span>
      ${vm.status === 'running' ? button('Shut down', { kind: 'sm', icon: 'power', attrs: 'type="button" data-p="shutdown"' }) + button('Reboot', { kind: 'sm', icon: 'refresh', attrs: 'type="button" data-p="reboot"' })
        : button('Start', { kind: 'sm', icon: 'player-play', attrs: 'type="button" data-p="start"' })}` : '';
    power.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => pveAction(vm, b.dataset.p, async () => { await loadProxmoxVMs(); vms = PVE.vms; if (d.isConnected) drawPower(); })));
  };
  sel.addEventListener('change', drawPower);
  drawPower();
  // Suggest a match for a host that is not linked yet.
  if (!current && host) {
    try {
      const r = await api('GET', `/proxmox/suggest?name=${encodeURIComponent(host.name || '')}&address=${encodeURIComponent(host.address || '')}`);
      if (r.match && d.isConnected && !sel.value) {
        const m = r.match;
        const why = m.reason === 'name' ? 'has the same name' : 'reports this host’s address';
        note.innerHTML = `${icon('info-circle')}<span>Looks like <strong>${esc(m.name)}</strong> (${pveKind(m.type)} ${m.vmid}): it ${why}. <button type="button" class="link" id="pve-use">Use it</button></span>`;
        note.classList.add('suggest');
        $('#pve-use', note).addEventListener('click', () => {
          sel.value = `${m.server_id}|${m.type}|${m.vmid}`;
          sel.dispatchEvent(new Event('change'));
          note.textContent = '';
          note.classList.remove('suggest');
        });
      }
    } catch (e) { /* a suggestion is optional */ }
  }
}

// What the host form sends for the link: undefined keeps the saved one.
function proxmoxFromForm(fd, host) {
  if (!fd.has('pve')) return undefined;
  const v = String(fd.get('pve') || '');
  if (!v) return host && host.proxmox ? { server_id: '' } : undefined;
  const [server_id, type, vmid] = v.split('|');
  return { server_id, type, vmid: Number(vmid) };
}

/* ---- opening a linked host ---- */

// A linked host whose VM is off offers to start it first.
async function pveGuard(host, go) {
  let status = '';
  try { status = (await api('GET', `/proxmox/servers/${host.proxmox.server_id}/${host.proxmox.type}/${host.proxmox.vmid}`)).status; } catch (e) { return go(); } // can not tell: just connect
  if (status !== 'stopped') return go();
  const vm = { server_id: host.proxmox.server_id, type: host.proxmox.type, vmid: host.proxmox.vmid, name: host.name };
  dialog(`${host.name} is powered off`, '', {
    description: 'The virtual machine is stopped. Start it and WebTerm connects as soon as it is up, which usually takes under a minute.',
    submitLabel: 'Start and connect',
    onSubmit: async () => { await pveSend(vm, 'start'); setTimeout(() => go({ wait: true }), 0); },
  });
}

// Waits for a freshly started host to answer, then connects.
async function pveWaitThenConnect(sess) {
  showOverlay(sess, { title: `Starting ${esc(sess.host.name)}…`, text: 'Waiting for the virtual machine to boot.', buttons: [closeButton(sess)] });
  const until = Date.now() + 3 * 60 * 1000;
  while (!sess.closed && Date.now() < until) {
    try { if ((await api('GET', `/hosts/${sess.host.id}/reachable`)).up) return connect(sess); } catch (e) { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (sess.closed) return;
  setState(sess, 'fatal');
  showOverlay(sess, {
    tone: 'danger', title: `${esc(sess.host.name)} did not come up`,
    text: 'The virtual machine was started, but nothing answered on its port within three minutes. It may still be booting.',
    buttons: [{ label: 'Try again', cls: 'primary', fn: () => pveWaitThenConnect(sess) }, closeButton(sess)],
  });
}

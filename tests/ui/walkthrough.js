const { chromium } = require('playwright');
// Walks through every screen in headless Chromium and saves screenshots. Run it with tests/ui/run.sh.
const OUT = process.env.OUT || '/work/out';
const BASE = process.env.BASE || 'http://webterm:3000';
const results = [];
let page;
const snap = async name => { await page.waitForTimeout(450); await page.screenshot({ path: `${OUT}/${name}.png` }); };
const step = async (name, fn) => { try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message.split('\n')[0]); try { await snap('FAIL-' + name.replace(/\W+/g, '-')); } catch (e2) { /* ignore */ } } };
const trust = async () => { await page.click('button:has-text("Trust and connect")'); await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 }); };
const dlg = () => page.locator('dialog[open]');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1360, height: 840 }, colorScheme: 'dark' });
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('/api/')) errors.push(`http ${r.status()} ${r.url()}`); });

  await step('setup page', async () => { await page.goto('/'); await page.waitForSelector('form'); await snap('00-setup'); });
  await step('create account', async () => {
    await page.fill('input[name=username]', 'owner');
    await page.fill('input[name=password]', 'test-password-1234');
    await page.fill('input[name=confirm]', 'test-password-1234');
    await page.click('button:has-text("Create account")');
    await page.waitForSelector('input[name=saved]');
    await snap('01-recovery-key');
    await page.check('input[name=saved]');
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('#shell');
  });
  await step('version shows in the sidebar', async () => {
    if (!/Version \S+/.test(await page.locator('.side .version').innerText())) throw new Error('no version in the sidebar');
  });
  await step('welcome (no hosts)', async () => { await snap('02-welcome-empty'); });

  await step('add folder', async () => {
    await page.click('#add-folder');
    await dlg().locator('input[name=name]').fill('Home lab');
    await dlg().locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  });
  const addHost = async (name, extra = {}) => {
    await page.click('#add-host');
    const d = dlg();
    if (extra.protocol) await d.locator('select[name=protocol]').selectOption(extra.protocol);
    await d.locator('input[name=name]').fill(name);
    await d.locator('select[name=folder_id]').selectOption({ label: 'Home lab' });
    await d.locator('input[name=address]').fill(extra.address || 'sbui-ssh');
    if (extra.protocol !== 'rdp') await d.locator('input[name=port]').fill('2222');
    await d.locator('input[name=username]').fill(extra.user || 'tester');
    await d.locator('input[name=password]').fill('testpass-123');
    if (extra.snap) await snap(extra.snap);
    await d.locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  };
  await step('host dialog + save', async () => { await addHost('pi-hole', { snap: '03-host-dialog' }); });
  await step('second host', async () => { await addHost('nas'); });
  await step('rdp host dialog', async () => {
    await page.click('#add-host');
    await dlg().locator('select[name=protocol]').selectOption('rdp');
    await dlg().locator('input[name=name]').fill('media pc');
    await dlg().locator('input[name=address]').fill('desktop');
    await dlg().locator('input[name=password]').fill('x');
    await snap('04-host-dialog-rdp');
    await dlg().locator('summary:has-text("Display and devices")').click();
    await dlg().locator('select[name=res]').selectOption('custom');
    await dlg().locator('input[name=rw]').fill('1600');
    await dlg().locator('input[name=rh]').fill('900');
    await dlg().locator('select[name=layout]').selectOption('de-de-qwertz');
    await dlg().locator('input[name=wallpaper]').check();
    await snap('04b-rdp-display');
    await dlg().locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  });
  await step('sidebar + welcome with hosts', async () => { await snap('05-sidebar-hosts'); });

  await step('open host, host key prompt', async () => {
    await page.click('.row.host:has-text("pi-hole")');
    await page.waitForSelector('.tbox');
    await snap('06-hostkey');
    await trust();
  });
  await step('terminal works', async () => {
    await page.keyboard.type('echo hello from webterm; uname -m');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows') && document.querySelector('.xterm-rows').innerText.includes('hello from webterm'), null, { timeout: 8000 });
    await snap('07-terminal');
  });
  await step('terminal fits its pane', async () => {
    const gap = await page.evaluate(() => {
      const t = document.querySelector('.pane .term:not([hidden])'); const s = t.querySelector('.xterm-screen');
      return Math.round(t.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom);
    });
    if (gap < 0) throw new Error(`the last terminal row is ${-gap}px below the pane`);
  });
  await step('saved commands bar', async () => {
    await page.waitForSelector('#cmdbar:visible');
    const rows = () => page.locator('.pane:visible .xterm-rows').first().innerText();
    const add = async (name, body) => {
      await page.click('[data-cmd-add]');
      await dlg().locator('input[name=name]').fill(name);
      await dlg().locator('textarea[name=body]').fill(body);
      await dlg().locator('button.primary').click();
      await page.waitForSelector('dialog[open]', { state: 'detached' });
    };
    await add('Say hello', 'echo hello-from-{{user}}');
    await page.click('.cmd:has-text("Say hello")');
    await page.waitForFunction(() => document.querySelector('.pane .xterm-rows').innerText.includes('echo hello-from-tester'));
    if ((await rows()).split('\n').some(l => l.trim() === 'hello-from-tester')) throw new Error('inserting a command ran it');
    await page.keyboard.press('Control+u');
    await page.locator('.cmd:has-text("Say hello")').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => document.querySelector('.pane .xterm-rows').innerText.split('\n').some(l => l.trim() === 'hello-from-tester'), null, { timeout: 8000 });
    await add('Two lines', 'echo a\necho b');
    await page.click('.cmd:has-text("Two lines")');
    await dlg().locator('text=has 2 lines').waitFor();
    await snap('06a-command-confirm');
    await dlg().locator('[data-cancel]').first().click();
    await snap('06b-command-bar');
    await page.click('[data-cmd-manage]');
    await dlg().locator('[data-down="0"]').click();
    await page.waitForFunction(() => document.querySelector('dialog[open] .item .title').textContent.trim() === 'Two lines');
    await snap('06c-command-manage');
    await dlg().locator('[data-cancel]').last().click();
    await page.click('[data-cmd-hide]');
    if (await page.locator('#cmdbar').isVisible()) throw new Error('the bar did not hide');
    await page.click('#find');
    await page.locator('.pal-row:has-text("Show saved commands bar")').click();
    await page.waitForSelector('#cmdbar:visible');
  });
  await step('a finished session is not an error', async () => {
    await page.click('.pane:visible .term');
    await page.keyboard.type('exit'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.pane .xterm-rows').innerText.includes('session ended'), null, { timeout: 8000 });
    if (await page.locator('.tbox:visible').count()) throw new Error('a popup appeared when the shell exited normally');
    await snap('06e-session-ended');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.pane .xterm-rows').innerText.includes('reconnected'), null, { timeout: 8000 });
  });
  await step('palette', async () => {
    await page.click('#find');
    await page.waitForSelector('dialog.palette[open]');
    await snap('08-palette');
    await page.keyboard.type('nas');
    await snap('09-palette-filtered');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tbox');
    await trust();
    await snap('10-two-tabs');
  });
  await step('split pane via palette pick', async () => {
    await page.click('.pane:visible [data-act=split-row]');
    await page.waitForSelector('dialog.palette[open]');
    await snap('11-split-picker');
    await page.keyboard.type('pi-hole');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cell + .divider');
    await page.waitForTimeout(2500);
    await snap('12-split');
  });
  await step('tabs, hosts and folders reorder by dragging', async () => {
    const drag = async (from, toX, toY) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(toX, toY, { steps: 10 }); await page.mouse.up();
    };
    // Tabs: drag the first past the second, then move it back with Alt+arrow.
    const tabIds = () => page.evaluate(() => WS.tabs.map(t => t.id));
    if ((await tabIds()).length < 2) { await page.click('.row.host:has-text("nas") .row-main'); await page.waitForFunction(() => WS.tabs.length > 1); }
    const before = await tabIds();
    const t0 = await page.locator('#tabs .tab').nth(0).boundingBox(), t1 = await page.locator('#tabs .tab').nth(1).boundingBox();
    await drag({ x: t0.x + t0.width / 2 - 14, y: t0.y + t0.height / 2 }, t1.x + t1.width * 0.85, t1.y + t1.height / 2);
    if ((await tabIds())[0] !== before[1]) throw new Error('dragging a tab did not reorder the tabs');
    await page.locator('#tabs .tab-main').nth(0).focus();
    await page.keyboard.press('Alt+ArrowRight');
    if ((await tabIds())[0] !== before[0]) throw new Error('Alt+Right did not move the tab');

    // Hosts: drag nas above pi-hole, and check it is still there after a reload.
    const hostNames = () => page.locator('.tree .row.host .name').allInnerTexts();
    const folderRows = () => page.locator('.tree .row.folder .name').allInnerTexts();
    const nas = await page.locator('.row.host:has-text("nas") .row-main').boundingBox();
    const pi = await page.locator('.row.host:has-text("pi-hole") .row-main').boundingBox();
    const first = (await hostNames()).indexOf('nas') < (await hostNames()).indexOf('pi-hole') ? 'nas' : 'pi-hole';
    if (first === 'nas') await drag({ x: pi.x + 60, y: pi.y + pi.height / 2 }, nas.x + 60, nas.y + 2);
    else await drag({ x: nas.x + 60, y: nas.y + nas.height / 2 }, pi.x + 60, pi.y + 2);
    await page.waitForFunction(was => { const n = [...document.querySelectorAll('.tree .row.host .name')].map(x => x.textContent); return (n.indexOf('nas') < n.indexOf('pi-hole')) !== was; },
      first === 'nas', { timeout: 5000 }).catch(() => { throw new Error('dragging a host did not reorder it'); });
    const afterDrag = await hostNames();
    await page.reload(); await page.waitForSelector('#shell');
    const saved = await hostNames();
    if (JSON.stringify(saved) !== JSON.stringify(afterDrag)) throw new Error('the host order was not kept: ' + saved.join(',') + ' vs ' + afterDrag.join(','));

    // Folders: add a second one, and drag it above the first. It keeps its place after a reload.
    await page.evaluate(async () => { await api('POST', '/folders', { name: 'Zeta' }); await loadHosts(); });
    const home = await page.locator('.row.folder:has-text("Home lab") .row-main').boundingBox();
    const zeta = await page.locator('.row.folder:has-text("Zeta") .row-main').boundingBox();
    await drag({ x: zeta.x + 40, y: zeta.y + zeta.height / 2 }, home.x + 40, home.y + 2);
    await page.waitForFunction(() => { const n = [...document.querySelectorAll('.tree .row.folder .name')].map(x => x.textContent); return n.indexOf('Zeta') < n.indexOf('Home lab'); },
      null, { timeout: 5000 }).catch(() => { throw new Error('dragging a folder did not reorder it'); });
    const folders = await folderRows();
    await snap('06f-reordered');

    // The same without dragging: the buttons in the edit dialog.
    await page.click('.row.host:has-text("pi-hole") .kebab', { force: true });
    const movedFrom = await hostNames();
    const step = movedFrom.indexOf('pi-hole') < movedFrom.indexOf('nas') ? 1 : -1; // toward the other host in its folder
    await dlg().locator(`[data-move="${step}"]`).click();
    await page.waitForFunction(old => [...document.querySelectorAll('.tree .row.host .name')].map(n => n.textContent).join() !== old, movedFrom.join());
    await dlg().locator('[data-cancel]').first().click();
  });
  await step('ctrl+k outside a terminal', async () => {
    await page.click('.nav[data-view=identities]');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('dialog.palette[open]');
    await page.keyboard.press('Escape');
  });

  await step('identities empty', async () => { await snap('13-identities-empty'); });
  await step('new identity + push', async () => {
    await page.click('#id-new');
    await snap('14-identity-dialog');
    await dlg().locator('button.primary').click();
    await page.waitForSelector('#pgo');
    await dlg().locator('.prow:has-text("pi-hole") input').check();
    await snap('15-push-dialog');
    await page.click('#pgo');
    await page.waitForSelector('.res.ok', { timeout: 20000 });
    await snap('16-push-result');
    await dlg().locator('button:has-text("Close")').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await snap('17-identities');
  });

  const nav = async tab => { await page.click('.nav[data-view=settings]'); await page.click(`.subnav [data-tab=${tab}]`); };
  await step('settings account', async () => { await nav('account'); await snap('18-settings-account'); });
  await step('settings security + 2fa dialog', async () => {
    await nav('security'); await snap('19-settings-security');
    await page.click('#on');
    await page.waitForSelector('dialog[open] img.qr');
    await snap('20-2fa-dialog');
    await dlg().locator('[data-cancel]').first().click();
  });
  await step('settings appearance', async () => { await nav('appearance'); await snap('21-settings-appearance'); });
  await step('settings users + add user', async () => {
    await nav('users'); await snap('22-settings-users');
    await page.click('#add');
    await snap('23-add-user');
    await dlg().locator('[data-cancel]').first().click();
  });
  await step('settings server', async () => { await nav('server'); await snap('24-settings-server'); });
  await step('tailscale dialog', async () => {
    await nav('tailscale');
    await page.waitForSelector('#tsedit');
    await page.click('#tsedit');
    await dlg().waitFor();
    await snap('24b-tailscale-dialog');
    await dlg().locator('[data-cancel]').first().click();
    // Turning it on without having joined before asks for an auth key instead of switching on.
    await page.locator('label.switch:has(#tson)').click();
    await dlg().waitFor();
    await dlg().locator('[data-cancel]').first().click();
    if (await page.locator('#tson').isChecked()) throw new Error('the switch turned on without a key');
  });

  await step('pane overlays close with an x', async () => {
    await page.click('.row.host:has-text("pi-hole")');
    await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 });
    await page.evaluate(() => { const s = WS.active.active; showOverlay(s, { title: 'Session ended', buttons: [{ label: 'Reconnect', cls: 'primary', fn() {} }, closeButton(s)] }); });
    if (await page.locator('.tbox button:has-text("Close pane")').count()) throw new Error('a Close pane button is still there');
    await snap('49-overlay-x');
    const before = await page.locator('#tabs .tab').count();
    await page.locator('.tbox [data-close]:visible').click();
    await page.waitForFunction(n => document.querySelectorAll('#tabs .tab').length < n, before);
  });
  await step('closing the last pane shows the home page', async () => {
    await page.click('.row.host:has-text("pi-hole")');
    await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 });
    for (let n = 0; n < 12 && await page.locator('.pane [data-act=close]:visible').count(); n++) await page.locator('.pane [data-act=close]:visible').first().click();
    await page.waitForSelector('#empty:not([hidden])');
    if (await page.locator('#tabs .tab').count()) throw new Error('tabs left behind');
    await snap('47-home-after-close');
  });
  await step('edit a host after closing panes, and show its saved password', async () => {
    await page.click('.row.host:has-text("nas") .kebab', { force: true });
    const host = page.locator('dialog[open]').first();
    await host.waitFor();
    await host.locator('[data-reveal]').click();
    const ask = page.locator('dialog[open]').last();
    await ask.locator('input[name=password]').fill('test-password-1234');
    await ask.locator('button.primary').click();
    await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 1);
    const pw = host.locator('input[name=password]');
    if (await pw.inputValue() !== 'testpass-123' || await pw.getAttribute('type') !== 'text') throw new Error('saved password not shown');
    await snap('48-password-shown');
    await host.locator('[data-reveal]').click();
    if (await pw.getAttribute('type') !== 'password') throw new Error('password not hidden again');
    await host.locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.waitForTimeout(300);
  });

  await step('connection failure explains itself', async () => {
    await page.click('#add-host');
    const d = dlg();
    await d.locator('input[name=name]').fill('unreachable');
    await d.locator('input[name=address]').fill('sbui-ssh');
    await d.locator('input[name=port]').fill('1');
    await d.locator('input[name=username]').fill('tester');
    await d.locator('input[name=password]').fill('testpass-123');
    await d.locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.click('.row.host:has-text("unreachable") .row-main');
    await page.waitForSelector('.tbox.danger .text:visible', { timeout: 20000 });
    const text = (await page.locator('.tbox.danger .text:visible').first().innerText()).trim();
    if (text.length < 20) throw new Error('error popup has no description: ' + text);
    await snap('26a-connect-error');
    await page.locator('.tbox [data-close]:visible').click();
  });
  await step('sidebar collapses and comes back', async () => {
    await page.click('.nav[data-view=identities]');
    await page.click('#collapse');
    if (await page.locator('#side').isVisible()) throw new Error('the sidebar is still showing');
    await snap('26b-sidebar-collapsed');
    await page.reload(); await page.waitForSelector('#shell');
    if (await page.locator('#side').isVisible()) throw new Error('the sidebar did not stay collapsed after a reload');
    await page.click('#menu');
    if (!(await page.locator('#side').isVisible())) throw new Error('the sidebar did not come back');
  });
  await step('tailscale status in the sidebar', async () => {
    const reply = { enabled: true, state: 'connected', hostname: 'webterm-owner', serve_ui: true, port: 3000, has_state: true, peers: [] };
    await page.route('**/api/tailscale', r => (r.request().method() === 'GET' ? r.fulfill({ json: reply }) : r.continue()));
    await page.evaluate(() => pollTailscale());
    await page.locator('#ts-status:visible').waitFor();
    if (!/Connected/.test(await page.locator('#ts-status').innerText())) throw new Error('the sidebar does not say Connected');
    await snap('26c-tailscale-status');
    await page.click('#ts-status');
    await page.waitForSelector('#ts .panel');
    await page.unroute('**/api/tailscale');
    await page.evaluate(() => pollTailscale());
    await page.locator('#ts-status').waitFor({ state: 'hidden' });
  });
  await step('light theme', async () => {
    await nav('appearance');
    await page.click('.seg button[data-theme=light]');
    await snap('25-light-appearance');
    await page.click('.row.host:has-text("pi-hole")');
    await snap('26-light-workspace');
    await page.click('.nav[data-view=identities]'); await snap('27-light-identities');
    await page.click('#find'); await snap('28-light-palette'); await page.keyboard.press('Escape');
    await nav('users'); await snap('29-light-users');
  });
  await step('host dialog light', async () => {
    await page.click('.row.host:has-text("pi-hole")');
    await page.click('.row.host:has-text("pi-hole") .kebab', { force: true });
    await page.waitForSelector('dialog[open]');
    await snap('30-light-host-edit');
    await dlg().locator('[data-cancel]').first().click();
  });

  await step('style guide', async () => {
    await page.goto('/design.html'); await page.waitForSelector('#c-button');
    await page.waitForFunction(() => document.fonts.check('13px "Inter Variable"'));
    await page.screenshot({ path: `${OUT}/50-design-light.png`, fullPage: true });
    await page.evaluate(() => setThemeChoice('dark'));
    await page.screenshot({ path: `${OUT}/51-design-dark.png`, fullPage: true });
  });

  // phone
  const mctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  page = await mctx.newPage();
  page.on('pageerror', e => errors.push('mobile: ' + e.message));
  await step('mobile login', async () => {
    await page.goto('/'); await page.waitForSelector('form'); await snap('40-m-login');
    await page.fill('input[name=username]', 'owner'); await page.fill('input[name=password]', 'test-password-1234');
    await page.click('button:has-text("Sign in")'); await page.waitForSelector('#shell');
    await snap('41-m-shell');
  });
  await step('mobile drawer + terminal', async () => {
    await page.click('#menu'); await snap('42-m-drawer');
    await page.click('.row.host:has-text("pi-hole")');
    await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 });
    await snap('43-m-terminal');
  });
  await step('mobile settings + dialog', async () => {
    await page.click('#menu'); await page.click('.nav[data-view=settings]'); await snap('44-m-settings');
    await page.click('#menu'); await page.click('#add-host'); await snap('45-m-dialog');
  });

  await step('new folder from the host dialog', async () => {
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    if (!(await page.locator('#add-host').isVisible())) await page.click('#menu');
    await page.click('#add-host');
    const sel = dlg().locator('select[name=folder_id]');
    const labels = await sel.locator('option').allTextContents();
    if (labels[labels.length - 1].trim() !== '+ Add new folder') throw new Error('last folder option is ' + labels[labels.length - 1]);
    await sel.selectOption('__new');
    await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 2);
    await page.locator('dialog[open]').last().locator('input[name=name]').fill('Scratch');
    await page.locator('dialog[open]').last().locator('button.primary').click();
    await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 1);
    const chosen = await sel.evaluate(e => e.options[e.selectedIndex].textContent.trim());
    if (chosen !== 'Scratch') throw new Error('new folder not selected: ' + chosen);
    await snap('46-m-new-folder');
    await dlg().locator('[data-cancel]').first().click();
  });
  await step('losing the web session sends you to sign in', async () => {
    await page.setViewportSize({ width: 1360, height: 840 });
    await page.goto('/'); await page.waitForSelector('#shell');
    await page.click('.row.host:has-text("pi-hole") .row-main');
    await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 });
    await page.context().clearCookies(); // what a server restart does to this browser's session
    await page.evaluate(() => WS.active.active.sock.close());
    await page.waitForSelector('button:has-text("Sign in")', { timeout: 15000 });
    await snap('47-signed-out');
  });
  console.log(results.join('\n'));
  console.log('page errors:', errors.length ? errors.slice(0, 8).join(' | ') : 'none');
  if (results.some(r => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
  await browser.close();
})().catch(e => { console.error('SCRIPT FAILED', e); process.exit(1); });

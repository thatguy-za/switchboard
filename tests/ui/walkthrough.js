const { chromium } = require('playwright');
// Walks through every screen in headless Chromium and saves screenshots. Run it with tests/ui/run.sh.
const OUT = process.env.OUT || '/work/out';
const BASE = process.env.BASE || 'http://switchboard:3000';
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
    await page.keyboard.type('echo hello from switchboard; uname -m');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows') && document.querySelector('.xterm-rows').innerText.includes('hello from switchboard'), null, { timeout: 8000 });
    await snap('07-terminal');
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
    await dlg().locator('button:has-text("Done")').click();
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

  console.log(results.join('\n'));
  console.log('page errors:', errors.length ? errors.slice(0, 8).join(' | ') : 'none');
  if (results.some(r => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
  await browser.close();
})().catch(e => { console.error('SCRIPT FAILED', e); process.exit(1); });

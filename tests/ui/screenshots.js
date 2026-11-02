const { chromium } = require('playwright');
// Takes the screenshots in docs/screenshots for the README, against a throwaway server with demo data.
// Run it with tests/ui/screenshots.sh.
const OUT = process.env.OUT || '/work/shots';
const BASE = process.env.BASE || 'http://webterm:3000';
const SCALE = 2;
const dlg = () => page.locator('dialog[open]');
let page;
const snap = async (name, opts = {}) => { await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${name}.png`, ...opts }); console.log('saved', name); };
// Types a command and waits for the prompt to come back, so output never interleaves.
const type = async text => {
  await page.keyboard.type(text); await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.pane:not([hidden]) .xterm-rows')].map(r => r.innerText).join('\n').split('\n').map(l => l.trimEnd()).filter(Boolean);
    return rows.length && rows[rows.length - 1].endsWith('$');
  }, null, { timeout: 10000 });
};
const trust = async () => {
  await page.locator('.pane:visible button:has-text("Trust and connect")').last().click();
  await page.waitForFunction(() => document.querySelectorAll('.pane .overlay, .tover:not([hidden])').length === 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1360, height: 840 }, deviceScaleFactor: SCALE, colorScheme: 'dark' });
  page = await ctx.newPage();

  await page.goto('/'); await page.waitForSelector('form');
  await page.fill('input[name=username]', 'alex');
  await page.fill('input[name=password]', 'demo-password-1234');
  await page.fill('input[name=confirm]', 'demo-password-1234');
  await page.click('button:has-text("Create account")');
  await page.waitForSelector('input[name=saved]'); await page.check('input[name=saved]');
  await page.click('button:has-text("Continue")'); await page.waitForSelector('#shell');

  for (const name of ['Home lab', 'Work']) {
    await page.click('#add-folder');
    await dlg().locator('input[name=name]').fill(name);
    await dlg().locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  }
  const addHost = async (name, folder, rdp = false) => {
    await page.click('#add-host');
    const d = dlg();
    if (rdp) await d.locator('select[name=protocol]').selectOption('rdp');
    await d.locator('input[name=name]').fill(name);
    await d.locator('select[name=folder_id]').selectOption({ label: folder });
    await d.locator('input[name=address]').fill('sbui-ssh');
    if (!rdp) await d.locator('input[name=port]').fill('2222');
    await d.locator('input[name=username]').fill('tester');
    await d.locator('input[name=password]').fill('testpass-123');
    await d.locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  };
  await addHost('pi-hole', 'Home lab'); await addHost('nas', 'Home lab'); await addHost('media-pc', 'Home lab', true);
  await addHost('dev-box', 'Work'); await addHost('staging', 'Work');

  await page.click('.nav[data-view=settings]'); await page.click('.subnav [data-tab=server]');
  await page.locator('label.switch:has(#keydone)').click();
  await page.click('.nav[data-view=identities]');
  await page.click('.row.host:has-text("pi-hole") .row-main'); await trust();
  await type('clear'); await type('uname -sr; uptime'); await type('df -h | head -6'); await type('ls -la /etc | head -8');
  for (const [name, body] of [['Uptime', 'uptime'], ['Memory', 'free -m'], ['Disk usage', 'df -h'], ['Top processes', 'ps -o pid,user,comm | head'], ['Update packages', 'sudo apt update && sudo apt upgrade']]) {
    await page.click('[data-cmd-add]');
    await dlg().locator('input[name=name]').fill(name);
    await dlg().locator('textarea[name=body]').fill(body);
    await dlg().locator('button.primary').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  }
  await snap('workspace');

  await page.click('.pane:visible [data-act=split-row]');
  await page.waitForSelector('dialog.palette[open]');
  await page.keyboard.type('nas'); await page.keyboard.press('Enter');
  await page.waitForSelector('.cell + .divider'); await trust();
  await type('clear'); await type('ps -o pid,user,time,comm | head -12');
  await page.click('.cell:first-child .term'); await type('clear'); await type('ls -la /etc | head -10');
  await snap('split-panes');

  await page.click('#find'); await page.waitForSelector('dialog.palette[open]');
  await snap('search'); await page.keyboard.press('Escape');

  await page.click('#add-host');
  await dlg().locator('select[name=protocol]').selectOption('rdp');
  await dlg().locator('input[name=name]').fill('media-pc'); await dlg().locator('input[name=address]').fill('192.168.1.40');
  await dlg().locator('summary:has-text("Display and devices")').click();
  await snap('rdp-settings');
  await dlg().locator('[data-cancel]').first().click();

  await page.click('#find'); await page.waitForSelector('dialog.palette[open]');
  await page.keyboard.type('theme'); await page.keyboard.press('Enter');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(800);
  await snap('light');

  const mctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  page = await mctx.newPage();
  await page.goto('/'); await page.waitForSelector('form');
  await page.fill('input[name=username]', 'alex'); await page.fill('input[name=password]', 'demo-password-1234');
  await page.click('button:has-text("Sign in")'); await page.waitForSelector('#shell');
  await page.click('#menu'); await page.click('.row.host:has-text("pi-hole") .row-main'); await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.click('.cmd:has-text("Uptime")'); await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await page.click('.cmd:has-text("Memory")'); await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await snap('phone');
  await browser.close();
})().catch(e => { console.error('SCRIPT FAILED', e); process.exit(1); });

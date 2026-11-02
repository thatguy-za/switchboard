const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
// Runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules) over each screen. Run it with tests/ui/a11y.sh.
const BASE = process.env.BASE || 'http://webterm:3000';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const found = {};
let page;
const check = async name => {
  await page.waitForTimeout(400);
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of r.violations) {
    const k = v.id;
    found[k] = found[k] || { impact: v.impact, help: v.help, wcag: v.tags.filter(t => /^wcag\d{3,}$/.test(t)).join(','), where: {} };
    for (const n of v.nodes) (found[k].where[name] = found[k].where[name] || []).push(n.target.join(' ') + '  ' + (n.failureSummary || '').split('\n')[1]);
  }
  console.log(`${name}: ${r.violations.length} rules, ${r.violations.reduce((a, v) => a + v.nodes.length, 0)} nodes`);
};
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('SKIP ' + name + ': ' + e.message.split('\n')[0]); } };
const dlg = () => page.locator('dialog[open]');
const close = async () => { await dlg().locator('[data-cancel], button:has-text("Close")').first().click(); await page.waitForSelector('dialog[open]', { state: 'detached' }); };
const nav = async tab => { await page.click('.nav[data-view=settings]'); await page.click(`.subnav [data-tab=${tab}]`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1360, height: 840 }, colorScheme: 'dark' });
  page = await ctx.newPage();
  await step('setup', async () => { await page.goto('/'); await page.waitForSelector('form'); await check('setup'); });
  await step('account', async () => {
    await page.fill('input[name=username]', 'owner');
    await page.fill('input[name=password]', 'test-password-1234');
    await page.fill('input[name=confirm]', 'test-password-1234');
    await page.click('button:has-text("Create account")');
    await page.waitForSelector('input[name=saved]'); await check('recovery-key');
    await page.check('input[name=saved]'); await page.click('button:has-text("Continue")'); await page.waitForSelector('#shell');
    await check('welcome-empty');
  });
  await step('host dialog', async () => {
    await page.click('#add-host'); await check('host-dialog');
    const d = dlg();
    await d.locator('input[name=name]').fill('pi-hole'); await d.locator('input[name=address]').fill('sbui-ssh');
    await d.locator('input[name=port]').fill('2222'); await d.locator('input[name=username]').fill('tester');
    await d.locator('input[name=password]').fill('testpass-123');
    await d.locator('button.primary').click(); await page.waitForSelector('dialog[open]', { state: 'detached' });
  });
  await step('rdp dialog', async () => {
    await page.click('#add-host'); await dlg().locator('select[name=protocol]').selectOption('rdp');
    await dlg().locator('summary:has-text("Display and devices")').click(); await check('rdp-dialog'); await close();
  });
  await step('folder dialog', async () => { await page.click('#add-folder'); await check('folder-dialog'); await close(); });
  await step('hosts sidebar', async () => { await check('sidebar-hosts'); });
  await step('host key + terminal', async () => {
    await page.click('.row.host:has-text("pi-hole")'); await page.waitForSelector('button:has-text("Trust and connect")'); await check('host-key-prompt');
    await page.click('button:has-text("Trust and connect")'); await page.waitForSelector('.tab.on .dot.live', { timeout: 15000 }); await check('terminal');
  });
  await step('commands', async () => {
    await page.click('[data-cmd-add]');
    await dlg().locator('input[name=name]').fill('Say hello'); await dlg().locator('textarea[name=body]').fill('echo hello');
    await check('command-dialog');
    await dlg().locator('button.primary').click(); await page.waitForSelector('dialog[open]', { state: 'detached' });
    await check('terminal-with-commands');
    await page.click('[data-cmd-manage]'); await check('commands-manage'); await close();
  });
  await step('palette', async () => { await page.click('#find'); await check('palette'); await page.keyboard.press('Escape'); });
  await step('identities', async () => { await page.click('.nav[data-view=identities]'); await check('identities'); await page.click('#id-new'); await check('identity-dialog'); await close(); });
  for (const t of ['account', 'security', 'appearance', 'tailscale', 'users', 'server']) await step(t, async () => { await nav(t); await check('settings-' + t); });
  await step('2fa dialog', async () => { await nav('security'); await page.click('#on'); await check('2fa-dialog'); await close(); });
  await step('add user', async () => { await nav('users'); await page.click('#add'); await check('add-user-dialog'); await close(); });
  await step('tailscale', async () => { await nav('tailscale'); await page.click('#tsedit'); await check('tailscale-dialog'); await close(); });
  await step('light', async () => {
    await nav('appearance'); await page.click('.seg button[data-theme=light]');
    await check('light-settings'); await page.click('.nav[data-view=identities]'); await check('light-identities');
    await page.click('#add-host'); await check('light-host-dialog'); await close();
  });
  await step('style guide', async () => { await page.goto('/design.html'); await page.waitForSelector('#c-button'); await check('style-guide'); });
  await step('mobile', async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await page.goto('/'); await page.waitForSelector('#shell');
    await check('mobile-home'); await page.click('#menu'); await check('mobile-drawer');
  });
  await step('reflow 320', async () => {
    await page.setViewportSize({ width: 320, height: 640 }); await page.goto('/'); await page.waitForSelector('#shell');
    console.log('horizontal scroll at 320px:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  });
  console.log('\n=== SUMMARY ===');
  for (const [id, f] of Object.entries(found)) {
    console.log(`\n[${f.impact}] ${id} (${f.wcag}) ${f.help}`);
    for (const [scr, list] of Object.entries(f.where)) console.log(`  ${scr}: ${list.length}\n    ` + [...new Set(list)].slice(0, 3).join('\n    '));
  }
  await browser.close();
  if (Object.keys(found).length) process.exit(1);
})();

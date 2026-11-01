// Optional check of the remote desktop pane against a real xrdp desktop (see tests/ui/README.md).
const { chromium } = require('playwright');
const OUT = process.env.OUT || '/work/out';
const BASE = process.env.BASE || 'http://switchboard:3000';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1360, height: 840 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const snap = async n => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${n}.png` }); };
  const report = {};

  await page.goto('/');
  await page.fill('input[name=username]', 'owner');
  await page.fill('input[name=password]', 'test-password-1234');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('#shell');
  await page.click('.row.host:has-text("xfce desktop")');
  await page.waitForSelector('.tab.on .dot.live', { timeout: 45000 });
  await page.waitForTimeout(4000);
  await snap('rdp-1-desktop');

  const box = await page.locator('.rdpscreen').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 14);
  await page.mouse.click(box.x + 40, box.y + 14);
  await page.waitForTimeout(800);
  await snap('rdp-2-menu');
  await page.mouse.move(box.x + 70, box.y + 60);
  await page.mouse.click(box.x + 70, box.y + 60);
  await page.waitForTimeout(4000);
  await page.keyboard.type('echo typed with real keys; uname -m');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await snap('rdp-3-typed');

  await page.click('[data-act=clip]');
  await snap('rdp-4-clipboard');
  await page.click('.rpanel.clip [data-clip=close]');
  await page.click('[data-act=files]');
  await page.setInputFiles('.rpanel.files .fileinput', { name: 'hello é.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the browser') });
  await page.waitForSelector('.fentry:has-text("hello")', { timeout: 15000 });
  await snap('rdp-5-files');
  report.fileListed = await page.locator('.fentry').allInnerTexts();

  await page.click('.rpanel.files [data-file=close]');
  const size = () => page.evaluate(() => { const s = leaves(WS.active.root)[0]; const d = s.client.getDisplay(); return { pane: [s.holder.clientWidth, s.holder.clientHeight], remote: [d.getWidth(), d.getHeight()] }; });
  report.before = await size();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(3000);
  report.after = await size();
  await snap('rdp-6-resized');

  // split with an SSH-less layout: a second pane of the same desktop is enough to see the chrome
  console.log(JSON.stringify({ ...report, pageErrors: errors }, null, 1));
  await browser.close();
})().catch(e => { console.error('RDP TEST FAILED', e.message); process.exit(1); });

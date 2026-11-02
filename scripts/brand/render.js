// Renders the PNG icons from the SVG sources in cmd/webterm/web. Run through scripts/brand/build.sh.
const { chromium } = require('playwright');
const fs = require('fs');
const WEB = '/web';
const ART = `<path d="M15 23 L19 41 L24 30 L29 41 L33 23" fill="none" stroke="#F3F1EA" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="38" y="21" width="11" height="22" rx="2" fill="#2FB383"/>`;
const svgs = {
  any: fs.readFileSync(`${WEB}/icon.svg`, 'utf8'),
  fav: fs.readFileSync(`${WEB}/favicon.svg`, 'utf8'),
  // Full-bleed square with no rounding, for iOS, which rounds the corners itself.
  square: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#14181F"/>${ART}</svg>`,
  // The artwork scaled into the central 80% safe zone.
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#14181F"/><g transform="translate(6.4 6.4) scale(.8)">${ART}</g></svg>`,
};
const jobs = [
  ['any', 192, 'icon-192.png', true], ['any', 512, 'icon-512.png', true],
  ['square', 180, 'apple-touch-icon.png', false], ['maskable', 512, 'icon-maskable-512.png', false],
  ['fav', 16, 'favicon-16.png', true], ['fav', 32, 'favicon-32.png', true], ['fav', 48, 'favicon-48.png', true],
];
(async () => {
  const browser = await chromium.launch();
  for (const [key, size, out, transparent] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svgs[key]}`);
    await page.screenshot({ path: `${WEB}/${out}`, omitBackground: transparent });
    await page.close();
  }
  await browser.close();
})();

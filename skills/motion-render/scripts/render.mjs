// Motion のプレーヤーを headless Chromium で開き、任意の時刻のコマを PNG で返す。
// ブラウザは playwright-core の版に対応する Chromium を使い、無ければ初回に自動で取得する。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = join(dirname(require.resolve('playwright-core')), 'cli.js');

const KIND = { '.css': 'css', '.html': 'html', '.js': 'js', '.json': 'json', '.txt': 'text' };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const REQUIRED = ['index.html', 'artifact-type/app.js', 'artifact-type/app.css', 'cut.js', 'modules/scenes.json'];

// The film's code is untrusted: no network, nothing outside the film dir, and Chromium's own
// sandbox stays on (Playwright turns it off by default).
const LAUNCH = {
  chromiumSandbox: true,
  args: ['--font-render-hinting=none', '--force-color-profile=srgb', '--disable-lcd-text', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
};

export function checkFilmDir(dir) {
  const missing = REQUIRED.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`${dir} is not a film dir (missing: ${missing.join(', ')}). Run "motion-render prepare" first.`);
}

function readFilm(dir) {
  const ls = (d) => (existsSync(d) ? readdirSync(d) : []);
  return {
    title: 'film',
    script: readFileSync(join(dir, 'cut.js'), 'utf8'),
    modules: ls(join(dir, 'modules')).map((n) => ({ name: n, kind: KIND[extname(n.replace(/~\d+$/, ''))], text: readFileSync(join(dir, 'modules', n), 'utf8') })),
    assets: ls(join(dir, 'assets')).map((n) => ({ name: n, mime: MIME[extname(n).toLowerCase()], base64: readFileSync(join(dir, 'assets', n)).toString('base64') })),
  };
}

async function launch() {
  const opts = process.env.CHROMIUM_PATH ? { ...LAUNCH, executablePath: process.env.CHROMIUM_PATH } : LAUNCH;
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (opts.executablePath || !/Executable doesn't exist/.test(String(e.message))) throw e;
    console.error('motion-render: downloading Chromium for this playwright-core version (first run only)...');
    const r = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium'], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error('Chromium download failed. Set CHROMIUM_PATH to a local Chrome or Chromium instead.');
    return chromium.launch(opts);
  }
}

// Opens the film and returns { meta, frame(t) -> PNG Buffer, warnings(), close() }.
export async function openFilm(dir) {
  checkFilmDir(dir);
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.context().addInitScript(() => { for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection']) Reflect.deleteProperty(globalThis, k); });
    let here = null;
    await page.context().route('**/*', (r) => {
      const u = r.request().url();
      if (!here && r.request().isNavigationRequest()) here = u.slice(0, u.lastIndexOf('/') + 1);
      return (here && u.startsWith(here)) || /^(data|blob):/.test(u) ? r.continue() : r.abort();
    });
    await page.goto(pathToFileURL(resolve(dir, 'index.html')).href + '#tools');
    await page.waitForFunction(() => typeof window.__animation === 'object');
    const res = await page.evaluate((f) => window.__animation.load(f), readFilm(dir));
    if (res.error) throw new Error('film failed to load: ' + (res.error.message || res.error));
    return {
      meta: res.meta,
      async frame(t) {
        const url = await page.evaluate((tt) => window.__animation.frame(tt, { scale: 1 }), t);
        return Buffer.from(url.split(',')[1], 'base64');
      },
      async warnings() {
        const log = await page.evaluate(() => window.__animation.consoleLog());
        return log.filter((l) => l.level !== 'log').map((l) => `${l.level}: ${l.text}`);
      },
      close: () => browser.close(),
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

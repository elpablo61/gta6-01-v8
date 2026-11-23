// Crescent Bay screenshot tool — fresh from the prose spec.
// Regenerates the 4 deterministic poses (seed 7) from shots.json via
// the game's shot handle, then builds the contact sheet.
// Usage: node tools/screenshots.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_JSON = path.join(ROOT, 'shots.json');
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const GAME_DIR = path.join(ROOT, 'game');
const PORT = 8932;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const EXE = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureServer() {
  try {
    const res = await fetch(URL);
    if (res.ok) return null;
  } catch (e) { /* not up */ }
  const child = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', GAME_DIR], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const res = await fetch(URL);
      if (res.ok) return child;
    } catch (e) { /* retry */ }
  }
  throw new Error('static server did not come up on ' + PORT);
}

function killServer(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill(); } catch (e2) {} }
}

const shots = JSON.parse(fs.readFileSync(SHOTS_JSON, 'utf8'));
console.log(`shots.json: seed=${shots.seed}, ${shots.shots.length} poses`);

const serverChild = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-gpu'] });
const errors = [];
const results = [];
try {
  for (const pose of shots.shots) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${pose.name}] ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => errors.push(`[${pose.name}] ${String(e && e.message || e).slice(0, 200)}`));
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1200);
    // The shot handle applies poses BY NAME (apply(poseObject) is a
    // silent no-op that returns null); verify the pose landed.
    const applied = await page.evaluate((p) => {
      const s = window.__crescentBay.shots;
      try {
        const ret = s.apply(p.name);
        return ret ? 'apply(name)' : 'apply(name)->null';
      } catch (e) {
        return 'FAILED: ' + String(e.message).slice(0, 150);
      }
    }, pose);
    if (String(applied).startsWith('FAILED') || String(applied).includes('->null')) {
      console.log(`  ${pose.name}: ${applied}`);
      results.push({ name: pose.name, ok: false, note: applied });
      await page.close();
      continue;
    }
    await page.waitForTimeout(1800);
    const state = await page.evaluate(() => {
      const g = window.__crescentBay.game;
      return { state: g.state, timeHour: +g.timeHour.toFixed(1), stars: g.stars, cars: g.cars.length, police: g.police.length, enemies: g.enemies.length };
    });
    const expect = {
      '1-cover': () => state.state === 'playing' && state.stars >= 3 && Math.abs(state.timeHour - 13) < 1,
      '2-mission': () => state.state === 'dialog' && state.enemies >= 3 && Math.abs(state.timeHour - 16) < 1,
      '3-night': () => state.state === 'playing' && state.stars >= 3 && (state.timeHour >= 22 || state.timeHour <= 1) && state.police > 0,
      '4-start': () => state.state === 'title' && Math.abs(state.timeHour - 11) < 1,
    }[pose.name];
    const poseOk = expect ? expect() : true;
    if (!poseOk) {
      console.log(`  ${pose.name}: POSE NOT LANDED ${JSON.stringify(state)}`);
      results.push({ name: pose.name, ok: false, note: 'pose not landed: ' + JSON.stringify(state) });
      await page.close();
      continue;
    }
    const outPath = path.join(SHOTS_DIR, pose.file);
    let quality = 85;
    await page.screenshot({ path: outPath, type: 'jpeg', quality });
    let size = fs.statSync(outPath).size;
    if (size > 200 * 1024) {
      quality = 70;
      await page.screenshot({ path: outPath, type: 'jpeg', quality });
      size = fs.statSync(outPath).size;
    }
    console.log(`  ${pose.name}: ${pose.file} ${size} bytes (q${quality}) ${JSON.stringify(state)} via ${applied}`);
    results.push({ name: pose.name, ok: size <= 200 * 1024, note: `${size} bytes` });
    await page.close();
  }
} finally {
  await browser.close();
  killServer(serverChild);
}

// Contact sheet (PIL) — cover large on top, three small below.
const sheet = spawn('python3', ['tools/contact-sheet.py'], { cwd: ROOT, stdio: 'inherit' });
await new Promise((resolve) => sheet.on('close', resolve));

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== SCREENSHOTS: ${passed}/${results.length} (each <=200 KiB) ===`);
console.log(`  console/page errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('    ' + e);
process.exit(passed === results.length && errors.length === 0 ? 0 : 1);

// Crescent Bay playtest driver — fresh from the prose spec.
// Modes: cold | edge | arc | fps | all
//   cold: load + boot + title + new game + autopilot dialog accept
//   edge: radio / saves / weapons / combat / helicopter / spray shop /
//         garage / game-over / pause / fleeing peds / dialog buttons
//   arc:  full 12-mission arc by autopilot (m1..m12), progress logged
//         to /tmp/arc-progress.txt every 2s
//   fps:  wanted chase at 3 stars, rAF frames over 10s
// Usage: node tools/playtest.mjs [mode] [--mission m5] [--timeout 240]
// The arc mode accepts --mission to run a single mission (m1..m12).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(ROOT, 'game');
const PORT = 8931;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const EXE = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const PROGRESS_FILE = '/tmp/arc-progress.txt';

const mode = process.argv[2] || 'cold';
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const missionFilter = arg('--mission', null);
const perMissionTimeout = Number(arg('--timeout', '240')) * 1000;

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

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e && e.message || e).slice(0, 300)));
  page.on('requestfailed', (r) => errors.push('[reqfail] ' + r.url().slice(0, 120)));
  return { page, errors };
}

// Runs inside the page: returns a compact state snapshot.
function snapState() {
  const cb = window.__crescentBay || {};
  const g = cb.game;
  const m = cb._modules || {};
  const ap = m.autopilot;
  return {
    state: g?.state,
    time: g ? Math.round(g.time) : 0,
    mission: g?.missionId || null,
    missionName: g?.missionName || null,
    timer: g?.missionTimer == null ? null : Math.round(g.missionTimer),
    player: g?.player ? { x: Math.round(g.player.x), y: Math.round(g.player.y), onFoot: g.player.onFoot, speed: Math.round(g.player.speed || 0), cash: Math.round(g.player.cash), health: Math.round(g.player.health), car: !!g.player.car, weapon: g.player.currentWeapon, ammo: g.player.ammo } : null,
    cars: g?.cars?.length, peds: g?.pedestrians?.length, police: g?.police?.length,
    enemies: g?.enemies?.length, bullets: g?.bullets?.length,
    stars: g?.stars, heat: g ? Math.round(g.heat) : 0,
    heli: g?.helicopter ? { active: !!g.helicopter.active, hp: Math.round(g.helicopter.hp || 0) } : null,
    objective: g?.objective || null,
    dialog: g?.dialog ? { fixer: g.dialog.fixer } : null,
    garageOpen: !!g?.garageOpen,
    ap: ap ? { active: ap.active, status: ap.status } : null,
  };
}

async function startNewGame(page) {
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.click('#new-game-btn');
  await page.waitForTimeout(800);
}

async function waitFor(page, fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // fn arrives as source text; invoke it as an expression in the page.
    const ok = await page.evaluate(`(${fn})()`);
    if (ok) return true;
    await sleep(500);
  }
  throw new Error('timeout waiting for: ' + label);
}

function report(name, checks, errors) {
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n=== ${name}: ${passed}/${checks.length} ===`);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? ' — ' + c.note : ''}`);
  console.log(`  console/page errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('    ' + e);
  return passed === checks.length && errors.length === 0;
}

async function runCold(browser) {
  const { page, errors } = await newPage(browser);
  const checks = [];
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);
  let s = await page.evaluate(snapState);
  checks.push({ name: 'page boots, handle present', ok: !!s.state });
  checks.push({ name: 'all modules wired', ok: await page.evaluate(() => { const w = window.__crescentBay._wired || {}; return Object.values(w).every(Boolean); }), note: await page.evaluate(() => JSON.stringify(window.__crescentBay._wired)) });
  checks.push({ name: 'title screen visible, state=title', ok: s.state === 'title' });
  const shot = await page.screenshot();
  checks.push({ name: 'canvas renders (non-blank shot)', ok: shot.length > 20000, note: shot.length + ' bytes' });
  checks.push({ name: 'traffic + peds alive on title', ok: (s.cars || 0) > 10 && (s.peds || 0) > 10, note: `cars=${s.cars} peds=${s.peds}` });
  await page.click('#new-game-btn');
  await page.waitForTimeout(800);
  s = await page.evaluate(snapState);
  checks.push({ name: 'new game opens m1 dialog', ok: s.state === 'dialog' && s.mission === 'm1', note: `state=${s.state} mission=${s.mission}` });
  await page.evaluate(() => window.__crescentBay._modules.autopilot.enable());
  const accepted = await waitFor(page, `() => window.__crescentBay.game.state === 'playing'`, 15000, 'autopilot accepts dialog').catch(() => false);
  checks.push({ name: 'autopilot accepts dialog', ok: accepted });
  const p0 = await page.evaluate(snapState);
  await page.waitForTimeout(4000);
  const p1 = await page.evaluate(snapState);
  const moved = Math.hypot(p1.player.x - p0.player.x, p1.player.y - p0.player.y);
  checks.push({ name: 'player moves under autopilot', ok: moved > 30, note: `moved ${Math.round(moved)}px in 4s` });
  const ok = report('COLD', checks, errors);
  await browser.close();
  return ok;
}

async function runEdge(browser) {
  const { page, errors } = await newPage(browser);
  const checks = [];
  await startNewGame(page);
  // Accept the m1 dialog manually (click), then drive edge checks.
  await page.click('#dialog-accept').catch(() => {});
  await page.waitForTimeout(500);
  let s = await page.evaluate(snapState);
  checks.push({ name: 'dialog accept button starts play', ok: s.state === 'playing', note: `state=${s.state}` });

  // 1. Radio cycles 3 stations, name changes each time.
  const stations = await page.evaluate(() => {
    const cb = window.__crescentBay;
    const names = [cb.radioStation];
    cb.cycleRadioStation(); names.push(cb.radioStation);
    cb.cycleRadioStation(); names.push(cb.radioStation);
    cb.cycleRadioStation(); names.push(cb.radioStation);
    return names;
  });
  checks.push({ name: 'radio cycles 3 stations', ok: stations[0] !== stations[1] && stations[1] !== stations[2] && stations[2] !== stations[3] && stations[0] === stations[3], note: stations.join(' → ') });

  // 2. Save slots: write all 3, read back, load slot 1.
  const saves = await page.evaluate(() => {
    const cb = window.__crescentBay;
    const out = {};
    for (let slot = 1; slot <= 3; slot++) { cb.writeSlot(slot); }
    // Main slots 1..3 map to the save module's 0-based slots 0..2.
    out.read = [1, 2, 3].map((slot) => !!cb._modules.save.readSlot(slot - 1));
    return out;
  });
  checks.push({ name: 'save slots write x3 + read back', ok: saves.read.every(Boolean), note: JSON.stringify(saves.read) });
  await page.evaluate(() => window.__crescentBay.loadSlot(1));
  await page.waitForTimeout(500);
  s = await page.evaluate(snapState);
  checks.push({ name: 'load slot 1 resumes play', ok: s.state === 'playing', note: `state=${s.state}` });

  // 3. Weapon switching: give smg + shotgun, select each, cycle.
  const weapons = await page.evaluate(() => {
    const cb = window.__crescentBay;
    cb.giveWeapon('smg'); cb.giveWeapon('shotgun');
    const out = {};
    cb.selectWeapon('smg'); out.smg = cb.game.player.currentWeapon;
    cb.selectWeapon('shotgun'); out.shotgun = cb.game.player.currentWeapon;
    cb.cycleWeapon(); out.afterCycle = cb.game.player.currentWeapon;
    return out;
  });
  checks.push({ name: 'weapon select smg/shotgun + cycle', ok: weapons.smg === 'smg' && weapons.shotgun === 'shotgun', note: JSON.stringify(weapons) });

  // 4. Combat fire drains ammo, counts shots.
  const combat = await page.evaluate(() => {
    const cb = window.__crescentBay;
    const before = cb._modules.combat.state();
    cb._modules.combat.fire(cb.game.player.x, cb.game.player.y, 0, cb.game.enemies);
    const after = cb._modules.combat.state();
    return { ammoBefore: before.ammo[before.current], ammoAfter: after.ammo[after.current], shotsBefore: before.shotsFired, shotsAfter: after.shotsFired };
  });
  checks.push({ name: 'combat fire drains ammo + counts shot', ok: combat.ammoAfter === combat.ammoBefore - 1 && combat.shotsAfter === combat.shotsBefore + 1, note: JSON.stringify(combat) });

  // 5. Wanted 3 → helicopter appears, spotlight blocks heat decay.
  await page.evaluate(() => window.__crescentBay.setWanted(3));
  const heli = await waitFor(page, `() => { const h = window.__crescentBay.game.helicopter; return h && h.active; }`, 8000, 'helicopter active at 3 stars').catch(() => false);
  const blocks = await page.evaluate(() => window.__crescentBay._modules.helicopter.blocksHeatDecay());
  checks.push({ name: 'helicopter appears at 3 stars', ok: heli, note: `blocksHeatDecay=${blocks}` });

  // 6. Spray Shop drains heat (no police near, stars forced 0).
  const spray = await page.evaluate(() => {
    const g = window.__crescentBay.game;
    g.heat = 80; g.stars = 0; g.police.length = 0;
    const shop = { x: 2600, y: 2200 };
    g.player.x = shop.x; g.player.y = shop.y;
    if (g.player.car) { g.player.car.x = shop.x; g.player.car.y = shop.y; }
    return g.heat;
  });
  await page.waitForTimeout(3000);
  s = await page.evaluate(snapState);
  checks.push({ name: 'spray shop drains heat', ok: s.heat < spray - 20, note: `heat ${spray} → ${s.heat}` });

  // 7. Garage: cash + car + zone → open, buy cheapest, close.
  const garage = await page.evaluate(() => {
    const cb = window.__crescentBay;
    const g = cb.game;
    g.player.cash = 5000;
    const out = {};
    if (!g.player.car) {
      const car = g.cars.find((c) => c.parked) || g.cars[0];
      if (car) { g.player.car = car; g.player.onFoot = false; car.x = 1400; car.y = 1800; g.player.x = 1400; g.player.y = 1800; }
    } else { g.player.car.x = 1400; g.player.car.y = 1800; g.player.x = 1400; g.player.y = 1800; }
    cb.openGarageMenu();
    out.open = g.garageOpen;
    out.bought = cb.buyCheapestUpgrade();
    cb.closeGarageMenu();
    out.closed = !g.garageOpen && g.state === 'playing';
    out.cash = Math.round(g.player.cash);
    return out;
  });
  checks.push({ name: 'garage open + buy cheapest + close', ok: garage.open && garage.bought && garage.closed, note: JSON.stringify(garage) });

  // 8. Game over + retry restarts the mission.
  await page.evaluate(() => window.__crescentBay.endGame('DOWN'));
  await page.waitForTimeout(500);
  s = await page.evaluate(snapState);
  const overOk = s.state === 'gameover';
  await page.click('#retry-btn').catch(() => {});
  await page.waitForTimeout(800);
  s = await page.evaluate(snapState);
  checks.push({ name: 'game over → retry restarts mission', ok: overOk && (s.state === 'dialog' || s.state === 'playing'), note: `after retry: ${s.state} mission=${s.mission}` });

  // 9. Pause toggle via Escape (from playing, not from a dialog).
  await page.click('#dialog-accept').catch(() => {});
  await page.waitForTimeout(400);
  s = await page.evaluate(snapState);
  if (s.state === 'dialog') {
    // The retry left a dialog open; accept it directly so pause can be tested.
    await page.evaluate(() => { const cb = window.__crescentBay; cb.game.dialog = null; cb.game.state = 'playing'; });
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  s = await page.evaluate(snapState);
  const paused = s.state === 'paused';
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  s = await page.evaluate(snapState);
  checks.push({ name: 'pause toggle (Esc)', ok: paused && s.state === 'playing', note: `paused=${paused} after=${s.state}` });

  // 10. Gunfire scares pedestrians (real input path: mouse click).
  // The player must be on foot — shooting from a car is not possible.
  await page.evaluate(() => {
    const g = window.__crescentBay.game;
    g.player.car = null;
    g.player.onFoot = true;
    const near = g.pedestrians.find((p) => Math.hypot(p.x - g.player.x, p.y - g.player.y) < 500) || g.pedestrians[0];
    if (near) { g.player.x = near.x + 50; g.player.y = near.y; }
  });
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const flee = await page.evaluate(() => {
    const g = window.__crescentBay.game;
    return { fleeing: g.pedestrians.filter((p) => p.fleeing).length, total: g.pedestrians.length };
  });
  checks.push({ name: 'gunfire scares pedestrians', ok: flee.fleeing > 0, note: `${flee.fleeing}/${flee.total} fleeing` });

  // 11. Mission dialog accept button (fresh dialog via startMission).
  await page.evaluate(() => window.__crescentBay.startMission(window.__crescentBay.game.missionId || 'm1'));
  await page.waitForTimeout(400);
  await page.click('#dialog-accept').catch(() => {});
  await page.waitForTimeout(400);
  s = await page.evaluate(snapState);
  checks.push({ name: 'mission dialog accept button', ok: s.state === 'playing', note: `state=${s.state}` });

  const ok = report('EDGE', checks, errors);
  await browser.close();
  return ok;
}

async function runFps(browser) {
  const { page, errors } = await newPage(browser);
  await startNewGame(page);
  await page.click('#dialog-accept').catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const cb = window.__crescentBay;
    cb.setWanted(3);
    const g = cb.game;
    for (let i = 0; i < 4; i++) {
      g.police.push({ kind: 'car', x: g.player.x - 200 - i * 80, y: g.player.y + (i - 1) * 60, angle: 0, speed: 300, color: '#2c3e50', topSpeed: 460, cruise: 430, route: null, routeIndex: 0, length: 48, width: 22, headlights: true });
    }
  });
  await page.waitForTimeout(1000);
  const fps = await page.evaluate(() => new Promise((res) => {
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - start < 10000) requestAnimationFrame(tick);
      else res({ frames, seconds: (performance.now() - start) / 1000 });
    };
    requestAnimationFrame(tick);
  }));
  const avg = fps.frames / fps.seconds;
  console.log(`\n=== FPS: ${avg.toFixed(1)} avg over ${fps.seconds.toFixed(1)}s (${fps.frames} frames, wanted chase) ===`);
  console.log(`  console/page errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('    ' + e);
  await browser.close();
  return avg >= 50 && errors.length === 0;
}

async function runArc(browser) {
  const { page, errors } = await newPage(browser);
  const t0 = Date.now();
  const log = (line) => {
    const msg = `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`;
    console.log(msg);
    try { fs.appendFileSync(PROGRESS_FILE, msg + '\n'); } catch (e) {}
  };
  try { fs.writeFileSync(PROGRESS_FILE, 'arc start ' + new Date().toISOString() + '\n'); } catch (e) {}
  await startNewGame(page);
  await page.evaluate(() => window.__crescentBay._modules.autopilot.enable());
  const completed = [];
  const flags = { heliSeen: false, garagePurchase: false, weaponFired: false };
  let current = 'm1';
  let missionStart = Date.now();
  let lastState = null;
  let dialogStuckSince = 0;
  const MISSIONS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'];
  const want = missionFilter ? [missionFilter] : MISSIONS;
  if (missionFilter) {
    await page.evaluate((id) => { window.__crescentBay.startMission(id); }, missionFilter);
    current = missionFilter;
    missionStart = Date.now();
    log(`single-mission mode: ${missionFilter}`);
  }
  log('arc running: autopilot enabled, m1 started');
  let result = 'TIMEOUT';
  while (Date.now() - t0 < 40 * 60 * 1000) {
    await sleep(2000);
    const s = await page.evaluate(snapState).catch(() => null);
    if (!s) { log('page evaluate failed (crashed?)'); break; }
    if (s.heli && s.heli.active) flags.heliSeen = true;
    if (s.player && s.player.weapon && s.player.weapon !== 'pistol') flags.weaponFired = true;
    const purchased = await page.evaluate(() => !!window.__crescentBay.game.missionGaragePurchase).catch(() => false);
    if (purchased) flags.garagePurchase = true;
    // Mission transition?
    if (s.mission !== current) {
      if (current && s.mission !== current) {
        completed.push(current);
        log(`MISSION DONE: ${current} -> ${s.mission || 'ALL DONE'} (cash $${s.player?.cash}) flags=${JSON.stringify(flags)}`);
      }
      current = s.mission;
      missionStart = Date.now();
      if (!current) { result = 'DONE'; break; }
      if (missionFilter && completed.includes(missionFilter)) { result = 'DONE'; break; }
    }
    // Stuck in dialog? Autopilot should accept; click as a fallback.
    if (s.state === 'dialog') {
      if (!dialogStuckSince) dialogStuckSince = Date.now();
      else if (Date.now() - dialogStuckSince > 20000) {
        await page.click('#dialog-accept').catch(() => {});
        log('dialog stuck 20s — clicked accept as fallback');
        dialogStuckSince = 0;
      }
    } else dialogStuckSince = 0;
    // Game over? Retry.
    if (s.state === 'gameover') {
      log(`game over (${s.mission}) — retrying`);
      await page.click('#retry-btn').catch(() => {});
      await sleep(800);
    }
    // Per-mission timeout?
    if (Date.now() - missionStart > perMissionTimeout) {
      log(`MISSION TIMEOUT: ${current} after ${Math.round(perMissionTimeout / 1000)}s — last=${JSON.stringify(lastState)} now=${JSON.stringify(s)}`);
      result = 'TIMEOUT:' + current;
      break;
    }
    // Progress line every ~10s.
    if (Math.round((Date.now() - t0) / 1000) % 10 === 0 && JSON.stringify(s) !== JSON.stringify(lastState)) {
      log(`... ${current} state=${s.state} player=(${s.player?.x},${s.player?.y}) ${s.player?.onFoot ? 'foot' : 'car'} speed=${s.player?.speed} obj=${s.objective?.text || '-'} stars=${s.stars} heat=${s.heat} ap=${s.ap?.status || '-'}`);
    }
    lastState = s;
  }
  const passed = missionFilter ? completed.includes(missionFilter) : completed.length === 12;
  console.log(`\n=== ARC: ${result} — completed ${completed.length}/12: ${completed.join(', ')} ===`);
  console.log(`  flags: ${JSON.stringify(flags)}`);
  console.log(`  console/page errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('    ' + e);
  console.log(`  progress log: ${PROGRESS_FILE}`);
  await browser.close();
  return passed && errors.length === 0;
}

const serverChild = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-gpu'] });
let ok = false;
try {
  if (mode === 'cold') ok = await runCold(browser);
  else if (mode === 'edge') ok = await runEdge(browser);
  else if (mode === 'arc') ok = await runArc(browser);
  else if (mode === 'fps') ok = await runFps(browser);
  else if (mode === 'all') {
    ok = (await runCold(browser)) && (await runEdge(browser)) && (await runFps(browser));
    console.log('\n(all: arc runs separately — it takes up to ~40 min)');
  } else {
    console.log('unknown mode: ' + mode);
  }
} finally {
  try { await browser.close(); } catch (e) {}
  killServer(serverChild);
}
process.exit(ok ? 0 : 1);

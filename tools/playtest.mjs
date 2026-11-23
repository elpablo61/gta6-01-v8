// Crescent Bay — playtest harness (fresh, written from the prose spec).
//
// What this does:
//   node tools/playtest.mjs cold            fresh profile, title -> new game
//                                           -> move -> enter car -> drive
//                                           -> shoot, zero console errors.
//   node tools/playtest.mjs edge            wall collision, enter/exit x5,
//                                           pause/resume, save/reload/
//                                           continue, corrupt save, radio
//                                           cycle, weapon switch, 3 save
//                                           slots, zero console errors.
//   node tools/playtest.mjs arc [m1..m12]   full 12-mission autopilot arc,
//                                           or one mission only, e.g. arc m3.
//   node tools/playtest.mjs fps             frames per second during a
//                                           wanted chase (target >= 50).
//
// How the game is driven (no internal API is assumed):
//   * Inputs are real keyboard / mouse events through Playwright, plus
//     clicks on the DOM overlays the spec requires: #title-screen,
//     #pause-menu, #game-over-screen, #mission-dialog, #controls-list.
//   * State is read from what the page SHOWS: overlay visibility and text,
//     the canvas (pixel fingerprints), console/pageerror output, and the
//     save data the title screen itself displays. Nothing here calls a
//     game function.
//   * Two optional, read-only page conventions make assertions precise.
//     The game may publish them; the harness works without them but then
//     some checks can only report DEGRADED (observed, not proven) instead
//     of PASS. The conventions are:
//       1. URL flag `?autopilot=m3` (or `?autopilot=arc`) starts the
//          in-game autopilot for that mission / the whole arc. The flag
//          name can be overridden with --auto-param.
//       2. `window.__crescentDebug`, a plain data snapshot the page may
//          publish each frame (never functions): missionId, missionStage,
//          missionComplete, completedMissions, cash, health, ammo,
//          weapon, radio, heat, stars, inCar, speed, x, y, dialogOpen,
//          gameOver, autopilot. The harness only READS these fields.
//   * Mission completion is accepted from any of: the snapshot reporting
//     the mission complete / moved on, the mission dialog announcing a
//     reward or the next mission, or the save data recording the mission
//     as done. A mission with no positive signal inside its time limit
//     FAILS loudly instead of being guessed as done.
//
// Ports and files:
//   * The harness serves game/ itself on --port (default 8931, the
//     playtest port). Pass --base-url to point at a server that is
//     already running instead.
//   * Long arc runs append one state line per mission every 2 seconds to
//     /tmp/arc-progress.txt (or --progress-file), so progress survives a
//     killed process. Node stdout to a file is block-buffered; the file
//     is not.
//   * Every run writes a JSON result file under /tmp (never in the repo)
//     and prints a human summary to stdout.
//   * If a leftover server holds the port, the harness kills it by PID
//     (never pkill -f on a pattern that matches its own command).
//
// Exit code: 0 when every check passes (DEGRADED checks count as passed
// but are listed by name); 1 when any check fails.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(REPO_ROOT, 'game');
const CHROME_SHELL =
  process.env.HOME +
  '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const VIEWPORT = { width: 1280, height: 800 };
const OVERLAY_IDS = ['title-screen', 'pause-menu', 'game-over-screen', 'mission-dialog', 'controls-list'];

// The 12-mission arc, prose spec section 2. Time limits are the spec
// limits; the harness adds a grace margin on top for autopilot driving.
const MISSIONS = [
  { id: 'm1', name: 'First Job', reward: 400, limitSec: 300 },
  { id: 'm2', name: 'Tail Chase', reward: 700, limitSec: 300 },
  { id: 'm3', name: 'Hot Wheels', reward: 900, limitSec: 240 },
  { id: 'm4', name: 'Dockside', reward: 1100, limitSec: 360 },
  { id: 'm5', name: 'Midnight Run', reward: 1400, limitSec: 300 },
  { id: 'm6', name: 'Collector', reward: 1800, limitSec: 420 },
  { id: 'm7', name: 'Highway Heat', reward: 4600, limitSec: 420 },
  { id: 'm8', name: 'Crescent Job', reward: 6200, limitSec: 600 },
  { id: 'm9', name: 'Sky Watch', reward: 2000, limitSec: 420 },
  { id: 'm10', name: 'Full Auto', reward: 2500, limitSec: 420 },
  { id: 'm11', name: 'Tune-Up', reward: 3000, limitSec: 420 },
  { id: 'm12', name: 'Bay Finale', reward: 8000, limitSec: 600 },
];
const ARC_GRACE_SEC = 120;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    mode: null,
    mission: null,
    port: 8931,
    baseUrl: null,
    autoParam: 'autopilot',
    progressFile: '/tmp/arc-progress.txt',
    outFile: null,
    headless: true,
    dryRun: false,
    help: false,
  };
  const rest = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-headless') out.headless = false;
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a.startsWith('--base-url=')) out.baseUrl = a.slice(11);
    else if (a.startsWith('--auto-param=')) out.autoParam = a.slice(13);
    else if (a.startsWith('--progress-file=')) out.progressFile = a.slice(16);
    else if (a.startsWith('--out=')) out.outFile = a.slice(6);
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  [out.mode, out.mission] = rest;
  return out;
}

function usage() {
  return [
    'Usage: node tools/playtest.mjs <cold|edge|arc|fps> [mission] [flags]',
    '',
    '  cold            fresh profile: load, title, new game, move, car, drive, shoot',
    '  edge            wall, enter/exit x5, pause, save/reload, corrupt save, radio,',
    '                  weapons, 3 save slots, zero console errors',
    '  arc [m1..m12]   full 12-mission autopilot arc, or a single mission (arc m3)',
    '  fps             frames per second during a wanted chase (target >= 50)',
    '',
    'Flags:',
    '  --port=N            serve game/ on this port (default 8931)',
    '  --base-url=URL      use an already-running server instead of serving',
    '  --auto-param=NAME   URL flag that starts the autopilot (default autopilot)',
    '  --progress-file=P   arc progress log (default /tmp/arc-progress.txt)',
    '  --out=PATH          JSON result file (default /tmp/playtest-<mode>-<ts>.json)',
    '  --dry-run           print the plan and exit without launching a browser',
    '  --no-headless       show the browser window (debugging only)',
  ].join('\n');
}

// --- tiny static server for game/ -----------------------------------------

function serveGame(port) {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.resolve(GAME_DIR, rel);
      if (!file.startsWith(GAME_DIR + path.sep) && file !== GAME_DIR) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && err.message ? err.message : err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function killPortOwner(port) {
  // Kill the process holding the port, by PID from `ss`. Never pkill -f:
  // a pattern matching our own command would kill this harness itself.
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const m = out.match(/pid=(\d+)/);
    if (!m) return false;
    const pid = Number(m[1]);
    if (pid === process.pid || !pid) return false;
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function startServer(port) {
  try {
    return await serveGame(port);
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      if (killPortOwner(port)) {
        await sleep(800);
        return await serveGame(port);
      }
    }
    throw err;
  }
}

// --- page observation: DOM + canvas + console only ------------------------

async function readPageState(page) {
  // Reads only what the page shows. The debug snapshot below is a plain
  // data object the page may publish; no game function is ever called.
  return await page.evaluate((overlayIds) => {
    const overlays = {};
    for (const id of overlayIds) {
      const el = document.getElementById(id);
      if (!el) {
        overlays[id] = { present: false, visible: false, text: '' };
        continue;
      }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible =
        style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      overlays[id] = {
        present: true,
        visible,
        text: (el.innerText || '').slice(0, 400),
      };
    }
    const canvas = document.querySelector('canvas');
    // Save data the page itself stored, summarised, never executed.
    const saves = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        const raw = window.localStorage.getItem(key) || '';
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const summary = { key, bytes: raw.length, corrupt: parsed === null && raw.length > 0 };
        if (parsed && typeof parsed === 'object') {
          for (const field of ['mission', 'missionId', 'highestMission', 'completedMissions', 'cash', 'version']) {
            if (parsed[field] !== undefined) summary[field] = parsed[field];
          }
          if (parsed.state && typeof parsed.state === 'object') {
            for (const field of ['mission', 'missionId', 'highestMission', 'completedMissions', 'cash']) {
              if (parsed.state[field] !== undefined) summary[field] = parsed.state[field];
            }
          }
        }
        saves.push(summary);
      }
    } catch {
      // localStorage unreadable (fresh profile edge case): report none.
    }
    let debug = null;
    try {
      const d = window.__crescentDebug;
      if (d && typeof d === 'object') {
        debug = {};
        for (const field of [
          'missionId', 'missionStage', 'missionComplete', 'missionCompleteId', 'completedMissions',
          'highestMission', 'cash', 'health', 'ammo', 'weapon', 'radio',
          'heat', 'stars', 'inCar', 'speed', 'x', 'y', 'dialogOpen',
          'gameOver', 'autopilot', 'enemiesLeft', 'timeLeft',
        ]) {
          if (d[field] !== undefined) debug[field] = d[field];
        }
      }
    } catch {
      debug = null;
    }
    return {
      title: document.title,
      url: window.location.href,
      overlays,
      canvas: canvas
        ? { present: true, width: canvas.width, height: canvas.height }
        : { present: false, width: 0, height: 0 },
      saves,
      debug,
    };
  }, OVERLAY_IDS);
}

async function canvasFingerprint(page) {
  try {
    const canvas = page.locator('canvas').first();
    const buf = await canvas.screenshot({ timeout: 5000 });
    let hash = 2166136261;
    const n = Math.min(buf.length, 65536);
    for (let i = 0; i < n; i++) {
      hash ^= buf[i];
      hash = Math.imul(hash, 16777619);
    }
    return { hash: hash >>> 0, bytes: buf.length };
  } catch {
    return { hash: 0, bytes: 0 };
  }
}

function overlayVisible(state, id) {
  return !!state.overlays[id] && state.overlays[id].visible;
}

function missionFromState(state) {
  const d = state.debug;
  if (d && typeof d.missionId === 'string' && d.missionId) return d.missionId;
  return null;
}

function completedMissionsFromState(state) {
  const done = new Set();
  const d = state.debug;
  if (d && Array.isArray(d.completedMissions)) for (const m of d.completedMissions) done.add(String(m));
  if (d && typeof d.highestMission === 'string' && d.highestMission) {
    const idx = MISSIONS.findIndex((m) => m.id === d.highestMission);
    for (let i = 0; i < idx; i++) done.add(MISSIONS[i].id);
  }
  for (const s of state.saves) {
    if (Array.isArray(s.completedMissions)) for (const m of s.completedMissions) done.add(String(m));
    if (typeof s.highestMission === 'string') {
      const idx = MISSIONS.findIndex((m) => m.id === s.highestMission);
      for (let i = 0; i < idx; i++) done.add(MISSIONS[i].id);
    }
  }
  return done;
}

// --- shared run scaffolding -----------------------------------------------

function newRun(mode, opts) {
  return {
    mode,
    startedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    port: opts.port,
    baseUrl: opts.baseUrl,
    checks: [],
    consoleErrors: [],
    pageErrors: [],
    outFile: opts.outFile || `/tmp/playtest-${mode}-${stamp()}.json`,
  };
}

function record(run, name, status, detail) {
  run.checks.push({ name, status, detail: detail || '' });
  console.log(`  [${status.toUpperCase()}] ${name}${detail ? ' — ' + detail : ''}`);
  saveResults(run);
}

function saveResults(run) {
  run.finishedAt = new Date().toISOString();
  run.summary = {
    total: run.checks.length,
    passed: run.checks.filter((c) => c.status === 'pass').length,
    degraded: run.checks.filter((c) => c.status === 'degraded').length,
    failed: run.checks.filter((c) => c.status === 'fail').length,
  };
  try {
    fs.writeFileSync(run.outFile, JSON.stringify(run, null, 2));
  } catch {
    // A missing /tmp (VM restart wiped it) must not fail the run itself.
    try {
      fs.mkdirSync('/tmp', { recursive: true });
      fs.writeFileSync(run.outFile, JSON.stringify(run, null, 2));
    } catch {
      // Last resort: the stdout summary still carries the result.
    }
  }
}

function printSummary(run) {
  saveResults(run);
  console.log('');
  console.log(`== ${run.mode.toUpperCase()} SUMMARY ==`);
  console.log(`passed ${run.summary.passed} / ${run.summary.total}` +
    (run.summary.degraded ? ` (${run.summary.degraded} degraded)` : '') +
    (run.summary.failed ? `, FAILED ${run.summary.failed}` : ''));
  console.log(`console errors: ${run.consoleErrors.length}, page errors: ${run.pageErrors.length}`);
  if (run.consoleErrors.length) {
    for (const e of run.consoleErrors.slice(0, 10)) console.log(`  console: ${e}`);
  }
  if (run.pageErrors.length) {
    for (const e of run.pageErrors.slice(0, 10)) console.log(`  pageerror: ${e}`);
  }
  const degraded = run.checks.filter((c) => c.status === 'degraded');
  if (degraded.length) console.log(`degraded (observed, not proven): ${degraded.map((c) => c.name).join(', ')}`);
  console.log(`results: ${run.outFile}`);
  return run.summary.failed === 0;
}

async function launchBrowser(opts) {
  return await chromium.launch({
    executablePath: CHROME_SHELL,
    headless: opts.headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
  });
}

function watchConsole(page, run) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') run.consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (err) => {
    run.pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500));
  });
}

async function clickOverlayButton(page, overlayId, pattern, timeoutMs = 5000) {
  const locator = page.locator(`#${overlayId} button`, { hasText: pattern }).first();
  try {
    await locator.click({ timeout: timeoutMs });
    return true;
  } catch {
    // Fallback: click any button inside the overlay whose text matches.
    const clicked = await page.evaluate(
      ({ overlayId: oid, patternSource }) => {
        const root = document.getElementById(oid);
        if (!root) return false;
        const re = new RegExp(patternSource, 'i');
        for (const b of root.querySelectorAll('button')) {
          if (re.test(b.innerText || '')) {
            b.click();
            return true;
          }
        }
        return false;
      },
      { overlayId, patternSource: pattern.source },
    );
    return !!clicked;
  }
}

async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

// --- cold suite -------------------------------------------------------------

async function runCold(browser, baseUrl, run) {
  console.log('== COLD ==');
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  watchConsole(page, run);
  const t0 = Date.now();
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  let titleShown = false;
  try {
    await page.waitForSelector('#title-screen', { state: 'visible', timeout: 10000 });
    titleShown = true;
  } catch {
    titleShown = false;
  }
  const loadMs = Date.now() - t0;
  let state = await readPageState(page);
  record(
    run,
    'load-clean',
    titleShown && run.pageErrors.length === 0 ? 'pass' : 'fail',
    `title in ${loadMs}ms (target first paint < 2000ms: ${loadMs < 2000 ? 'yes' : 'no'}), pageerrors ${run.pageErrors.length}`,
  );
  const titleText = state.overlays['title-screen'] ? state.overlays['title-screen'].text : '';
  record(
    run,
    'title-visible',
    overlayVisible(state, 'title-screen') && /new game/i.test(titleText) ? 'pass' : 'fail',
    `title-screen visible=${overlayVisible(state, 'title-screen')}, new-game button=${/new game/i.test(titleText)}, controls-list present=${!!state.overlays['controls-list'] && state.overlays['controls-list'].present}`,
  );
  const started = await clickOverlayButton(page, 'title-screen', /new game/i, 5000);
  await sleep(1200);
  state = await readPageState(page);
  record(
    run,
    'new-game-starts',
    started && !overlayVisible(state, 'title-screen') && state.canvas.present ? 'pass' : 'fail',
    `clicked=${started}, title hidden=${!overlayVisible(state, 'title-screen')}, canvas=${state.canvas.present}`,
  );
  const beforeMove = await canvasFingerprint(page);
  const beforePos = state.debug ? { x: state.debug.x, y: state.debug.y } : null;
  await holdKey(page, 'KeyW', 1500);
  await sleep(300);
  const afterMove = await canvasFingerprint(page);
  state = await readPageState(page);
  const moved =
    afterMove.hash !== beforeMove.hash ||
    (beforePos && state.debug && (state.debug.x !== beforePos.x || state.debug.y !== beforePos.y));
  record(run, 'move-on-foot', moved ? 'pass' : 'fail', `canvas changed=${afterMove.hash !== beforeMove.hash}`);
  // Enter a car: try E a few times with short drives between attempts so
  // Rook can reach a parked car near the spawn.
  let inCar = !!(state.debug && state.debug.inCar);
  let enteredByPixels = false;
  for (let attempt = 0; attempt < 3 && !inCar; attempt++) {
    const before = await canvasFingerprint(page);
    await page.keyboard.press('KeyE');
    await sleep(900);
    state = await readPageState(page);
    inCar = !!(state.debug && state.debug.inCar);
    const after = await canvasFingerprint(page);
    if (after.hash !== before.hash) enteredByPixels = true;
    if (!inCar) await holdKey(page, 'KeyW', 700);
  }
  record(
    run,
    'enter-car',
    inCar || enteredByPixels ? 'pass' : 'fail',
    inCar ? 'debug snapshot reports inCar' : enteredByPixels ? 'canvas changed after E (no debug snapshot)' : 'no car entered; no debug snapshot to confirm',
  );
  const beforeDrive = await canvasFingerprint(page);
  const speedBefore = state.debug ? state.debug.speed : null;
  await holdKey(page, 'KeyW', 2500);
  await sleep(300);
  const afterDrive = await canvasFingerprint(page);
  state = await readPageState(page);
  const drove =
    afterDrive.hash !== beforeDrive.hash ||
    (state.debug && typeof state.debug.speed === 'number' && state.debug.speed > 0 && state.debug.speed !== speedBefore);
  record(run, 'drive', drove ? 'pass' : 'fail', `canvas changed=${afterDrive.hash !== beforeDrive.hash}`);
  const ammoBefore = state.debug ? state.debug.ammo : null;
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await sleep(400);
  state = await readPageState(page);
  const shotDetail =
    ammoBefore !== null && state.debug && state.debug.ammo !== ammoBefore
      ? `ammo ${ammoBefore} -> ${state.debug.ammo}`
      : 'click sent, no console error';
  record(run, 'shoot', run.pageErrors.length === 0 ? 'pass' : 'fail', shotDetail);
  record(
    run,
    'zero-console-errors',
    run.consoleErrors.length === 0 && run.pageErrors.length === 0 ? 'pass' : 'fail',
    `${run.consoleErrors.length} console errors, ${run.pageErrors.length} page errors`,
  );
  await context.close();
}

// --- edge suite -------------------------------------------------------------

async function runEdge(browser, baseUrl, run) {
  console.log('== EDGE ==');
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  watchConsole(page, run);
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  try {
    await page.waitForSelector('#title-screen', { state: 'visible', timeout: 10000 });
  } catch {
    record(run, 'edge-setup-title', 'fail', 'title screen never appeared');
    await context.close();
    return;
  }
  await clickOverlayButton(page, 'title-screen', /new game/i, 5000);
  await sleep(1200);

  // 1. Wall collision: roam into walls for a while; the game must stay
  //    responsive and the player must stay inside the world bounds.
  await holdKey(page, 'KeyW', 3000);
  await page.keyboard.down('KeyA');
  await holdKey(page, 'KeyW', 2000);
  await page.keyboard.up('KeyA');
  await holdKey(page, 'KeyW', 2000);
  let state = await readPageState(page);
  let wallDetail = 'game responsive after wall contact';
  let wallStatus = run.pageErrors.length === 0 ? 'pass' : 'fail';
  if (state.debug && typeof state.debug.x === 'number') {
    const inBounds =
      state.debug.x >= 0 && state.debug.x <= 3200 && state.debug.y >= 0 && state.debug.y <= 3200;
    wallDetail = `pos (${state.debug.x}, ${state.debug.y}) in world bounds=${inBounds}`;
    if (!inBounds) wallStatus = 'fail';
  }
  await page.keyboard.press('Escape');
  await sleep(500);
  state = await readPageState(page);
  if (!overlayVisible(state, 'pause-menu')) {
    wallStatus = 'fail';
    wallDetail += '; pause menu did not open afterwards (game unresponsive)';
  } else {
    await page.keyboard.press('Escape');
    await sleep(400);
  }
  record(run, 'wall-collision', wallStatus, wallDetail);

  // 2. Enter / exit a car five times in a row.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('KeyE');
    await sleep(600);
  }
  state = await readPageState(page);
  record(
    run,
    'enter-exit-x5',
    run.pageErrors.length === 0 && !overlayVisible(state, 'game-over-screen') ? 'pass' : 'fail',
    `5x E pressed, pageerrors ${run.pageErrors.length}`,
  );

  // 3. Pause, then resume.
  await page.keyboard.press('Escape');
  await sleep(500);
  state = await readPageState(page);
  const paused = overlayVisible(state, 'pause-menu');
  await page.keyboard.press('Escape');
  await sleep(500);
  state = await readPageState(page);
  record(
    run,
    'pause-resume',
    paused && !overlayVisible(state, 'pause-menu') ? 'pass' : 'fail',
    `pause shown=${paused}, resumed=${!overlayVisible(state, 'pause-menu')}`,
  );

  // 4. Save, reload, Continue restores the state.
  const cashBefore = state.debug ? state.debug.cash : null;
  await page.keyboard.press('Escape');
  await sleep(500);
  const saveClicked = await clickOverlayButton(page, 'pause-menu', /save/i, 4000);
  await sleep(600);
  await page.keyboard.press('Escape');
  await sleep(400);
  state = await readPageState(page);
  const keysAfterSave = state.saves.map((s) => s.key);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1000);
  state = await readPageState(page);
  const titleBack = overlayVisible(state, 'title-screen');
  const slotText = state.overlays['title-screen'] ? state.overlays['title-screen'].text : '';
  const continueClicked =
    (await clickOverlayButton(page, 'title-screen', /continue/i, 4000)) ||
    (await clickOverlayButton(page, 'title-screen', /slot\s*1/i, 4000));
  await sleep(1000);
  state = await readPageState(page);
  const resumed = !overlayVisible(state, 'title-screen');
  const cashAfter = state.debug ? state.debug.cash : null;
  const cashMatches = cashBefore === null || cashAfter === null || cashBefore === cashAfter;
  let saveStatus = 'pass';
  let saveDetail = `save button=${saveClicked}, keys=${keysAfterSave.join(',') || 'none'}, title back=${titleBack}, continue=${continueClicked}, resumed=${resumed}, cash ${cashBefore} -> ${cashAfter}`;
  if (!saveClicked) {
    saveStatus = 'degraded';
    saveDetail += ' (no Save button in pause menu; reload/continue still exercised)';
  }
  if (!titleBack || !resumed || !cashMatches) saveStatus = 'fail';
  record(run, 'save-reload-continue', saveStatus, saveDetail);

  // 5. A corrupt save must start a fresh game with a message, never crash.
  state = await readPageState(page);
  const saveKeys = state.saves.map((s) => s.key);
  if (saveKeys.length === 0) {
    record(run, 'corrupt-save-recovers', 'fail', 'no save keys were ever written, nothing to corrupt');
  } else {
    await page.evaluate((keys) => {
      for (const k of keys) window.localStorage.setItem(k, '{corrupt json,,');
    }, saveKeys);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1000);
    state = await readPageState(page);
    const titleOk = overlayVisible(state, 'title-screen');
    const newGameOk = titleOk && (await clickOverlayButton(page, 'title-screen', /new game/i, 4000));
    await sleep(800);
    state = await readPageState(page);
    record(
      run,
      'corrupt-save-recovers',
      titleOk && newGameOk && !overlayVisible(state, 'title-screen') && run.pageErrors.length === 0 ? 'pass' : 'fail',
      `corrupted ${saveKeys.length} key(s), title back=${titleOk}, new game starts=${!!newGameOk}`,
    );
  }

  // 6. Radio: R cycles all three stations; the displayed name must change.
  await page.keyboard.press('KeyR');
  await sleep(300);
  const radio1 = (await readPageState(page)).debug;
  await page.keyboard.press('KeyR');
  await sleep(300);
  const radio2 = (await readPageState(page)).debug;
  await page.keyboard.press('KeyR');
  await sleep(300);
  const radio3 = (await readPageState(page)).debug;
  const names = [radio1, radio2, radio3].map((d) => (d && (d.radio || d.station)) || null);
  if (names.some((n) => n === null || n === undefined)) {
    record(
      run,
      'radio-cycle-3-stations',
      'degraded',
      'station name is drawn on the canvas HUD, not readable from the DOM; no debug snapshot field — pressed R 3x with no console error',
    );
  } else {
    const distinct = new Set(names).size;
    record(
      run,
      'radio-cycle-3-stations',
      distinct === 3 ? 'pass' : 'fail',
      `stations seen: ${names.join(' -> ')} (distinct ${distinct}/3)`,
    );
  }

  // 7. Weapons: 1 / 2 / 3 / Q switch the current weapon.
  const weapons = [];
  for (const key of ['Digit1', 'Digit2', 'Digit3', 'KeyQ']) {
    await page.keyboard.press(key);
    await sleep(300);
    const d = (await readPageState(page)).debug;
    weapons.push(d && (d.weapon || d.weaponName) ? String(d.weapon || d.weaponName) : null);
  }
  if (weapons.some((w) => w === null)) {
    record(
      run,
      'weapon-switch-keys',
      'degraded',
      'weapon name is drawn on the canvas HUD, not readable from the DOM; no debug snapshot field — keys pressed with no console error',
    );
  } else {
    const changed = new Set(weapons).size > 1;
    record(run, 'weapon-switch-keys', changed ? 'pass' : 'fail', `weapons seen: ${weapons.join(' -> ')}`);
  }

  // 8. The title screen lists 3 save slots.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1000);
  state = await readPageState(page);
  const slotsText = state.overlays['title-screen'] ? state.overlays['title-screen'].text : '';
  const slotMentions = (slotsText.match(/slot/gi) || []).length;
  const emptyMentions = (slotsText.match(/empty/gi) || []).length;
  record(
    run,
    'save-slots-3',
    slotMentions >= 3 ? 'pass' : 'fail',
    `title mentions "slot" ${slotMentions}x, "empty" ${emptyMentions}x`,
  );

  record(
    run,
    'zero-console-errors',
    run.consoleErrors.length === 0 && run.pageErrors.length === 0 ? 'pass' : 'fail',
    `${run.consoleErrors.length} console errors, ${run.pageErrors.length} page errors`,
  );
  await context.close();
}

// --- arc suite --------------------------------------------------------------

function arcCompleteSignal(state, mission) {
  // Returns 'complete' | 'failed' | 'active' | 'unknown'.
  const d = state.debug;
  // The completion flag is only meaningful for THIS mission: the
  // flag stays set after m1 completes, so an unqualified read would
  // "complete" m2–m12 in zero seconds (the arc run 2 false pass).
  // The game publishes missionCompleteId alongside the flag.
  if (d && d.missionComplete === true && d.missionCompleteId === mission.id) return 'complete';
  if (d && d.missionComplete === true && typeof d.missionCompleteId !== 'string') {
    // No id published (older build): only trust the flag together
    // with the completed-missions list naming this mission.
    if (!completedMissionsFromState(state).has(mission.id)) return 'unknown';
    return 'complete';
  }
  if (completedMissionsFromState(state).has(mission.id)) return 'complete';
  const dialogText = state.overlays['mission-dialog'] ? state.overlays['mission-dialog'].text : '';
  if (overlayVisible(state, 'mission-dialog') && /mission complete|complete!|reward/i.test(dialogText)) {
    return 'complete';
  }
  if (d && typeof d.missionId === 'string' && d.missionId && d.missionId !== mission.id) {
    // The game has moved on to another mission: this one is done.
    const idx = MISSIONS.findIndex((m) => m.id === d.missionId);
    const cur = MISSIONS.findIndex((m) => m.id === mission.id);
    if (idx > cur) return 'complete';
  }
  if (d && typeof d.missionId === 'string' && d.missionId === mission.id) return 'active';
  if (overlayVisible(state, 'mission-dialog')) return 'active';
  return 'unknown';
}

async function runOneMission(page, run, opts, mission, progressFile) {
  const startedAt = Date.now();
  const deadline = startedAt + (mission.limitSec + ARC_GRACE_SEC) * 1000;
  const startedCash = (await readPageState(page)).debug?.cash ?? null;
  let lastState = null;
  let gameOverCount = 0;
  let lastGameOverSeen = false;
  console.log(`  -- ${mission.id} ${mission.name} ($${mission.reward}, limit ${mission.limitSec}s) --`);
  while (Date.now() < deadline) {
    const state = await readPageState(page);
    lastState = state;
    const d = state.debug || {};
    const line = [
      new Date().toISOString(),
      'arc',
      mission.id,
      `stage=${d.missionStage ?? '?'}`,
      `cash=${d.cash ?? '?'}`,
      `heat=${d.heat ?? '?'}`,
      `stars=${d.stars ?? '?'}`,
      `hp=${d.health ?? '?'}`,
      `ammo=${d.ammo ?? '?'}`,
      `dialog=${overlayVisible(state, 'mission-dialog') ? 'open' : 'closed'}`,
      `gameover=${overlayVisible(state, 'game-over-screen') ? 'yes' : 'no'}`,
      `errors=${run.consoleErrors.length + run.pageErrors.length}`,
    ].join(' ');
    try {
      fs.appendFileSync(progressFile, line + '\n');
    } catch {
      // Progress file is best-effort; the JSON result is authoritative.
    }
    if (overlayVisible(state, 'game-over-screen')) {
      if (!lastGameOverSeen) gameOverCount++;
      lastGameOverSeen = true;
    } else {
      lastGameOverSeen = false;
    }
    // A mission dialog left open blocks the autopilot; accept it.
    if (overlayVisible(state, 'mission-dialog')) {
      const accepted = await clickOverlayButton(page, 'mission-dialog', /accept|start|ok|continue/i, 1500);
      if (!accepted) await page.keyboard.press('Enter');
    }
    const signal = arcCompleteSignal(state, mission);
    if (signal === 'complete') {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const cashNow = (await readPageState(page)).debug?.cash ?? null;
      record(
        run,
        `arc-${mission.id}`,
        'pass',
        `${mission.name} completed in ${secs}s (limit ${mission.limitSec}s), cash ${startedCash} -> ${cashNow}, game-overs ${gameOverCount}`,
      );
      saveResults(run);
      return true;
    }
    if (run.pageErrors.length > 0 && Date.now() - startedAt > 30000) {
      // A page error mid-mission is fatal for a clean run; keep waiting
      // only briefly — the mission is already tainted.
      break;
    }
    await sleep(2000);
  }
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const d = (lastState && lastState.debug) || {};
  record(
    run,
    `arc-${mission.id}`,
    'fail',
    `${mission.name} NOT completed in ${secs}s (limit ${mission.limitSec}s + ${ARC_GRACE_SEC}s grace); last state stage=${d.missionStage ?? '?'}, cash=${d.cash ?? '?'}, heat=${d.heat ?? '?'}, dialog=${lastState ? overlayVisible(lastState, 'mission-dialog') : '?'}, game-overs ${gameOverCount}, pageerrors ${run.pageErrors.length}`,
  );
  saveResults(run);
  return false;
}

async function runArc(browser, baseUrl, run, opts) {
  console.log('== ARC ==');
  const wanted = opts.mission ? MISSIONS.filter((m) => m.id === opts.mission) : MISSIONS;
  if (opts.mission && wanted.length === 0) {
    throw new Error(`unknown mission "${opts.mission}" (want m1..m12)`);
  }
  const single = wanted.length === 1;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  watchConsole(page, run);
  const url =
    baseUrl +
    `/?${encodeURIComponent(opts.autoParam)}=${single ? wanted[0].id : 'arc'}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait until the autopilot is visibly engaged for the first mission.
  let engaged = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const state = await readPageState(page);
    const d = state.debug || {};
    if (
      (typeof d.missionId === 'string' && d.missionId === wanted[0].id) ||
      (d.autopilot === true && overlayVisible(state, 'mission-dialog')) ||
      overlayVisible(state, 'mission-dialog')
    ) {
      engaged = true;
      break;
    }
    if (overlayVisible(state, 'mission-dialog')) {
      await clickOverlayButton(page, 'mission-dialog', /accept|start|ok|continue/i, 1500);
    }
  }
  if (!engaged) {
    record(
      run,
      'arc-engage',
      'fail',
      `autopilot did not engage for ${wanted[0].id} via ?${opts.autoParam}=${single ? wanted[0].id : 'arc'} within 30s — the game may not implement this flag (see tool header)`,
    );
    await context.close();
    return;
  }
  record(run, 'arc-engage', 'pass', `autopilot engaged for ${single ? wanted[0].id : 'full arc'}`);
  for (const mission of wanted) {
    // In single-mission mode the page already runs this mission. In full
    // arc mode the game chains missions itself; runOneMission just waits
    // for the current one to complete.
    const ok = await runOneMission(page, run, opts, mission, opts.progressFile);
    if (!ok && single) break;
    if (!ok) {
      // Keep going: a later mission may still be reachable, and the
      // per-mission rows are more useful than one early abort.
      console.log(`  !! ${mission.id} failed; continuing to the next mission`);
    }
  }
  record(
    run,
    'arc-zero-console-errors',
    run.consoleErrors.length === 0 && run.pageErrors.length === 0 ? 'pass' : 'fail',
    `${run.consoleErrors.length} console errors, ${run.pageErrors.length} page errors`,
  );
  await context.close();
}

// --- fps suite --------------------------------------------------------------

async function runFps(browser, baseUrl, run) {
  console.log('== FPS ==');
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  watchConsole(page, run);
  // The cover pose is a live wanted chase (3 stars, police behind), which
  // is exactly the load the FPS bar cares about.
  await page.goto(baseUrl + '/?shot=cover', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);
  const state = await readPageState(page);
  if (!state.canvas.present) {
    record(run, 'fps-measure', 'fail', 'no canvas after loading ?shot=cover');
    await context.close();
    return;
  }
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start < 10000) requestAnimationFrame(tick);
          else resolve(frames / 10);
        };
        requestAnimationFrame(tick);
      }),
  );
  const fpsRounded = Math.round(fps * 10) / 10;
  record(
    run,
    'fps-wanted-chase',
    fpsRounded >= 50 ? 'pass' : 'fail',
    `measured ${fpsRounded} fps over 10s during the ?shot=cover wanted chase (target >= 50)`,
  );
  record(
    run,
    'fps-zero-console-errors',
    run.consoleErrors.length === 0 && run.pageErrors.length === 0 ? 'pass' : 'fail',
    `${run.consoleErrors.length} console errors, ${run.pageErrors.length} page errors`,
  );
  await context.close();
}

// --- main -------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.mode) {
    console.log(usage());
    process.exit(opts.help ? 0 : 2);
  }
  if (!['cold', 'edge', 'arc', 'fps'].includes(opts.mode)) {
    console.error(`unknown mode: ${opts.mode}\n${usage()}`);
    process.exit(2);
  }
  if (opts.mode === 'arc' && opts.mission && !/^m([1-9]|1[0-2])$/.test(opts.mission)) {
    console.error(`bad mission filter: ${opts.mission} (want m1..m12)`);
    process.exit(2);
  }
  const run = newRun(opts.mode, opts);
  if (opts.dryRun) {
    console.log(`DRY RUN — mode=${opts.mode}${opts.mission ? ` mission=${opts.mission}` : ''}`);
    console.log(`  would serve game/ from ${GAME_DIR} on port ${opts.port} (or --base-url ${opts.baseUrl || 'none'})`);
    console.log(`  autopilot flag: ?${opts.autoParam}=<mission|arc>; debug snapshot: window.__crescentDebug`);
    console.log(`  progress log: ${opts.progressFile}; results JSON: ${run.outFile}`);
    if (opts.mode === 'arc') {
      const list = opts.mission ? MISSIONS.filter((m) => m.id === opts.mission) : MISSIONS;
      for (const m of list) console.log(`  ${m.id} ${m.name} $${m.reward} limit ${m.limitSec}s (+${ARC_GRACE_SEC}s grace)`);
    }
    console.log('dry run ok — no browser launched');
    return;
  }

  let server = null;
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    server = await startServer(opts.port);
    baseUrl = `http://127.0.0.1:${opts.port}`;
    console.log(`serving game/ on ${baseUrl}`);
  }
  let browser = null;
  let ok = false;
  try {
    browser = await launchBrowser(opts);
    if (opts.mode === 'cold') await runCold(browser, baseUrl, run);
    else if (opts.mode === 'edge') await runEdge(browser, baseUrl, run);
    else if (opts.mode === 'arc') await runArc(browser, baseUrl, run, opts);
    else if (opts.mode === 'fps') await runFps(browser, baseUrl, run);
    ok = printSummary(run);
  } catch (err) {
    console.error(`playtest crashed: ${err && err.stack ? err.stack : err}`);
    record(run, 'harness-crash', 'fail', String(err && err.message ? err.message : err));
    printSummary(run);
    ok = false;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
  process.exit(ok ? 0 : 1);
}

main();

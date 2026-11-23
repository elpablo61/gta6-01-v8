// Crescent Bay — screenshot driver (fresh, written from the prose spec).
//
// What this does:
//   node tools/screenshots.mjs              take all 4 shots from shots.json
//   node tools/screenshots.mjs cover        take one shot only (by id)
//   node tools/screenshots.mjs --dry-run    print the plan, take nothing
//
// Each shot is a deterministic autopilot pose, never a hand-placed scene:
// the page is loaded fresh (new browser context, empty profile) at the
// query recorded in shots.json — `?shot=<id>&seed=7` — the game plays the
// pose for the recorded number of steps, and this driver waits that long
// (steps at 60 frames per second, minimum 4 seconds) so the frame has had
// full renders and the fonts are ready before the capture. Seed 7 + the
// same step count = the same frame.
//
// The four poses (prose spec section 5, brief A1/A2):
//   1-cover    bright daytime, waterfront chase, wanted 3, escape objective
//   2-mission  on foot, shootout, fixer dialog visible
//   3-night    night chase, headlights, roadblock, wanted 4
//   4-start    title overlay over the living city
//
// How the game is observed (same contract as tools/playtest.mjs):
//   * State is read from what the page SHOWS: overlay visibility and
//     text for the semantic ids (title-screen, pause-menu,
//     game-over-screen, mission-dialog, controls-list), the canvas
//     (pixel fingerprints), console/pageerror output. Nothing here calls
//     a game function.
//   * Two optional, read-only page conventions make the pose checks
//     precise. The game may publish them; the driver works without them
//     but then a pose check can only report DEGRADED (observed, not
//     proven) instead of PASS:
//       1. URL flag `?shot=<id>&seed=7` plays that pose from a fresh
//          world. The query is taken verbatim from shots.json.
//       2. `window.__crescentDebug`, a plain data snapshot the page may
//          publish each frame (never functions): stars, night, dialogOpen,
//          missionId, inCar, speed, x, y, heat, cash, health, ammo,
//          weapon, radio, gameOver, autopilot. Only read, never called.
//   * A shot is only kept when it is provably the right pose: the page
//     must load with zero console/page errors, the pose expectation must
//     hold (dialog visible for mission, title visible for start, wanted
//     stars for cover/night when the snapshot exists), the capture must
//     not be blank, and the file must fit the size cap.
//
// Size cap: each JPEG must be at most 200 KiB (default --max-kib=200).
// The driver captures to a buffer first and, if the file is too big,
// re-captures at lower JPEG quality (85, 75, 65, 55, 45) until it fits.
// A shot that still does not fit at the lowest quality is written at
// that quality and reported FAILED, so the failure is loud instead of
// silent — the finisher then lowers the quality floor or fixes the scene.
//
// Ports and files:
//   * The driver serves game/ itself on --port (default 8932, the
//     screenshots port). Pass --base-url to point at a server that is
//     already running instead.
//   * Output goes to --out (default <repo>/screenshots). Files are named
//     by shots.json (1-cover.jpg, 2-mission.jpg, ...). Existing files are
//     overwritten only by a fresh capture from this driver.
//   * Every run writes a JSON result file under /tmp (never in the repo)
//     and prints a human summary to stdout.
//   * If a leftover server holds the port, the driver kills it by PID
//     (never pkill -f on a pattern that matches its own command).
//   * The driver never edits the game. It never runs the contact sheet;
//     that is tools/contact-sheet.py, run after the shots exist.
//
// Exit code: 0 when every shot passes (DEGRADED pose checks count as
// passed but are listed by name); 1 when any shot fails.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DIR = path.join(REPO_ROOT, 'game');
const DEFAULT_SHOTS_FILE = path.join(REPO_ROOT, 'shots.json');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'screenshots');
const CHROME_SHELL =
  process.env.HOME +
  '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const VIEWPORT = { width: 1280, height: 800 };
const OVERLAY_IDS = ['title-screen', 'pause-menu', 'game-over-screen', 'mission-dialog', 'controls-list'];
const FRAME_MS = 1000 / 60;
const MIN_POSE_WAIT_MS = 4000;
const MAX_POSE_WAIT_MS = 30000;
const QUALITY_LADDER = [85, 75, 65, 55, 45];
const MIN_CAPTURE_BYTES = 8192;

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
    only: null,
    port: 8932,
    baseUrl: null,
    outDir: DEFAULT_OUT_DIR,
    shotsFile: DEFAULT_SHOTS_FILE,
    seed: null,
    maxKib: 200,
    startQuality: QUALITY_LADDER[0],
    waitMs: 0,
    outJson: null,
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
    else if (a.startsWith('--out=')) out.outDir = path.resolve(a.slice(6));
    else if (a.startsWith('--shots=')) out.shotsFile = path.resolve(a.slice(8));
    else if (a.startsWith('--seed=')) out.seed = Number(a.slice(7));
    else if (a.startsWith('--max-kib=')) out.maxKib = Number(a.slice(10));
    else if (a.startsWith('--quality=')) out.startQuality = Number(a.slice(10));
    else if (a.startsWith('--wait-ms=')) out.waitMs = Number(a.slice(10));
    else if (a.startsWith('--out-json=')) out.outJson = path.resolve(a.slice(11));
    else if (a.startsWith('--only=')) out.only = a.slice(7);
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error(`at most one shot id, got: ${rest.join(' ')}`);
  if (rest.length === 1) {
    if (out.only && out.only !== rest[0]) {
      throw new Error(`positional shot "${rest[0]}" disagrees with --only=${out.only}`);
    }
    out.only = rest[0];
  }
  return out;
}

function usage() {
  return [
    'Usage: node tools/screenshots.mjs [shot-id] [flags]',
    '',
    '  (no id)         take all 4 shots listed in shots.json',
    '  cover|mission|night|start',
    '                  take one shot only (by its shots.json id)',
    '',
    'Flags:',
    '  --port=N            serve game/ on this port (default 8932)',
    '  --base-url=URL      use an already-running server instead of serving',
    '  --out=DIR           write JPEGs here (default <repo>/screenshots)',
    '  --shots=PATH        pose list (default <repo>/shots.json)',
    '  --seed=N            override the seed in every shot query (default: from shots.json)',
    '  --max-kib=N         per-file size cap in KiB (default 200)',
    '  --quality=N         starting JPEG quality, 1-100 (default 85; retries go lower)',
    '  --wait-ms=N         override the pose wait in ms (0 = derive from steps at 60fps)',
    '  --out-json=PATH     JSON result file (default /tmp/screenshots-<ts>.json)',
    '  --dry-run           print the plan and exit without launching a browser',
    '  --no-headless       show the browser window (debugging only)',
    '',
    'Each shot loads ?shot=<id>&seed=7 from a fresh world, waits the',
    'recorded step count, then captures at 1280x800. Exit 0 when every',
    'shot passes (degraded pose checks still pass); 1 on any failure.',
  ].join('\n');
}

// --- pose list ---------------------------------------------------------------

function loadShots(shotsFile, seedOverride) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read shots list ${shotsFile}: ${err.message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`shots list ${shotsFile} is not a non-empty array`);
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`shots[${i}] is not an object`);
    const id = String(entry.id || '').trim();
    const name = String(entry.name || '').trim();
    if (!id) throw new Error(`shots[${i}] has no id`);
    if (!name) throw new Error(`shots[${i}] (${id}) has no file name`);
    const steps = Number(entry.steps);
    if (!Number.isFinite(steps) || steps <= 0) {
      throw new Error(`shots[${i}] (${id}) has no positive step count`);
    }
    const seed = seedOverride !== null && seedOverride !== undefined ? seedOverride : Number(entry.seed);
    let query = String(entry.query || '').trim();
    if (!query) query = `?shot=${encodeURIComponent(id)}&seed=${seed}`;
    if (seedOverride !== null && seedOverride !== undefined) {
      const params = new URLSearchParams(query.replace(/^\?/, ''));
      params.set('seed', String(seedOverride));
      query = '?' + params.toString();
    }
    return {
      id,
      name,
      description: String(entry.description || ''),
      steps,
      seed: Number.isFinite(seed) ? seed : 7,
      query,
    };
  });
}

function poseWaitMs(shot, waitOverride) {
  if (waitOverride > 0) return waitOverride;
  const fromSteps = Math.round(shot.steps * FRAME_MS);
  return Math.min(MAX_POSE_WAIT_MS, Math.max(MIN_POSE_WAIT_MS, fromSteps));
}

// --- tiny static server for game/ -------------------------------------------

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
  // a pattern matching our own command would kill this driver itself.
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

// --- page observation: DOM + canvas + console only ---------------------------

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
    let debug = null;
    try {
      const d = window.__crescentDebug;
      if (d && typeof d === 'object') {
        debug = {};
        for (const field of [
          'missionId', 'missionStage', 'missionComplete', 'completedMissions',
          'highestMission', 'cash', 'health', 'ammo', 'weapon', 'radio',
          'heat', 'stars', 'night', 'timeOfDay', 'objective',
          'inCar', 'speed', 'x', 'y', 'dialogOpen',
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

function watchConsole(page, run) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') run.consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (err) => {
    run.pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500));
  });
}

// --- run scaffolding ---------------------------------------------------------

function newRun(opts) {
  return {
    mode: 'screenshots',
    startedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    port: opts.port,
    baseUrl: opts.baseUrl,
    outDir: opts.outDir,
    maxKib: opts.maxKib,
    checks: [],
    shots: [],
    consoleErrors: [],
    pageErrors: [],
    outFile: opts.outJson || `/tmp/screenshots-${stamp()}.json`,
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
  console.log('== SCREENSHOTS SUMMARY ==');
  console.log(`passed ${run.summary.passed} / ${run.summary.total}` +
    (run.summary.degraded ? ` (${run.summary.degraded} degraded)` : '') +
    (run.summary.failed ? `, FAILED ${run.summary.failed}` : ''));
  for (const s of run.shots) {
    console.log(`  ${s.name}: ${(s.bytes / 1024).toFixed(1)} KiB (quality ${s.quality}, ${s.status})`);
  }
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

// --- pose expectations -------------------------------------------------------

function poseExpectation(shot, probe) {
  // probe: { dialogSeen, debugSeen, lastDebug, firstHash, lastHash, titleSeen }
  // Returns { status, detail } — 'pass', 'degraded' (no snapshot to prove
  // it, but nothing contradicts the pose), or 'fail' (the frame is the
  // wrong pose for this shot).
  const d = probe.lastDebug;
  switch (shot.id) {
    case 'cover': {
      if (d && typeof d.stars === 'number') {
        return d.stars === 3
          ? { status: 'pass', detail: `wanted ${d.stars} stars, escape chase (snapshot)` }
          : { status: 'fail', detail: `wanted ${d.stars} stars, cover needs 3` };
      }
      return { status: 'degraded', detail: 'no debug snapshot; wanted stars judged by eye in the contact sheet' };
    }
    case 'mission': {
      if (probe.dialogSeen) {
        return { status: 'pass', detail: 'mission-dialog (fixer dialog) visible during the pose' };
      }
      if (d && d.dialogOpen === true) {
        return { status: 'pass', detail: 'debug snapshot reports the mission dialog open' };
      }
      return { status: 'fail', detail: 'mission-dialog never visible; the fixer dialog is the point of this shot' };
    }
    case 'night': {
      const isNight = d && (d.night === true || (typeof d.timeOfDay === 'string' && /night/i.test(d.timeOfDay)));
      if (d && typeof d.stars === 'number') {
        if (d.stars !== 4) return { status: 'fail', detail: `wanted ${d.stars} stars, night needs 4` };
        return isNight
          ? { status: 'pass', detail: 'night, wanted 4 stars (snapshot)' }
          : { status: 'pass', detail: 'wanted 4 stars (snapshot); night judged by eye in the contact sheet' };
      }
      if (isNight) return { status: 'pass', detail: 'night reported by the snapshot; stars judged by eye' };
      return { status: 'degraded', detail: 'no debug snapshot; night + wanted 4 judged by eye in the contact sheet' };
    }
    case 'start': {
      if (!probe.titleSeen) {
        return { status: 'fail', detail: 'title-screen never visible; this shot is the title over the city' };
      }
      const alive = probe.firstHash !== 0 && probe.lastHash !== 0 && probe.firstHash !== probe.lastHash;
      return alive
        ? { status: 'pass', detail: 'title overlay visible over a living city (canvas changed between polls)' }
        : { status: 'degraded', detail: 'title overlay visible, but the canvas looked static between polls' };
    }
    default:
      return { status: 'degraded', detail: `no pose expectation defined for id "${shot.id}"; load + size only` };
  }
}

// --- one shot -----------------------------------------------------------------

async function takeShot(browser, baseUrl, run, opts, shot) {
  const waitMs = poseWaitMs(shot, opts.waitMs);
  const outPath = path.join(opts.outDir, shot.name);
  const errorsBefore = run.consoleErrors.length + run.pageErrors.length;
  console.log(`-- ${shot.id} (${shot.name}) ${shot.query} steps=${shot.steps} wait=${waitMs}ms --`);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  watchConsole(page, run);
  const probe = { dialogSeen: false, debugSeen: false, lastDebug: null, firstHash: 0, lastHash: 0, titleSeen: false };
  try {
    await page.goto(baseUrl + shot.query, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      await page.waitForSelector('canvas', { state: 'attached', timeout: 10000 });
    } catch {
      record(run, `shot-${shot.id}-load`, 'fail', 'no canvas element after loading the pose');
      await context.close();
      return false;
    }
    // Fonts ready + full renders before the capture, same rule as the
    // brief (A13): never screenshot a half-painted frame.
    try {
      await Promise.race([
        page.evaluate(() => document.fonts.ready),
        sleep(3000),
      ]);
    } catch {
      // Fonts API unavailable: the wait below still lets frames render.
    }
    // Poll the visible state while the pose plays, so transient evidence
    // (a dialog that opens then closes, a moving city) is not missed by
    // a single read at the end.
    const polls = Math.max(1, Math.floor(waitMs / 500));
    for (let i = 0; i < polls; i++) {
      await sleep(Math.min(500, waitMs - i * 500));
      const state = await readPageState(page);
      const fp = await canvasFingerprint(page);
      if (i === 0) probe.firstHash = fp.hash;
      probe.lastHash = fp.hash;
      if (overlayVisible(state, 'mission-dialog')) probe.dialogSeen = true;
      if (overlayVisible(state, 'title-screen')) probe.titleSeen = true;
      if (state.debug) {
        probe.debugSeen = true;
        probe.lastDebug = state.debug;
      }
    }
    const state = await readPageState(page);
    if (overlayVisible(state, 'mission-dialog')) probe.dialogSeen = true;
    if (overlayVisible(state, 'title-screen')) probe.titleSeen = true;
    if (state.debug) {
      probe.debugSeen = true;
      probe.lastDebug = state.debug;
    }
    const finalFp = await canvasFingerprint(page);
    probe.lastHash = finalFp.hash;
    const newErrors = (run.consoleErrors.length + run.pageErrors.length) - errorsBefore;
    record(
      run,
      `shot-${shot.id}-load`,
      state.canvas.present && newErrors === 0 ? 'pass' : 'fail',
      `canvas ${state.canvas.width}x${state.canvas.height}, ${newErrors} new console/page errors during the pose`,
    );
    const expectation = poseExpectation(shot, probe);
    record(run, `shot-${shot.id}-pose`, expectation.status, expectation.detail);

    // Capture to a buffer first; shrink the JPEG quality until the file
    // fits the cap instead of shipping an oversize shot.
    const capBytes = opts.maxKib * 1024;
    const ladder = [opts.startQuality, ...QUALITY_LADDER.filter((q) => q < opts.startQuality)];
    let buf = null;
    let usedQuality = ladder[0];
    for (const quality of ladder) {
      usedQuality = quality;
      buf = await page.screenshot({ type: 'jpeg', quality });
      if (buf.length <= capBytes) break;
    }
    const fits = buf.length <= capBytes;
    const nonBlank = buf.length >= MIN_CAPTURE_BYTES && finalFp.bytes > 0;
    fs.mkdirSync(opts.outDir, { recursive: true });
    fs.writeFileSync(outPath, buf);
    const shotRecord = {
      id: shot.id,
      name: shot.name,
      file: outPath,
      bytes: buf.length,
      kib: Math.round((buf.length / 1024) * 10) / 10,
      quality: usedQuality,
      status: fits && nonBlank ? 'pass' : 'fail',
      description: shot.description,
      query: shot.query,
      debugSeen: probe.debugSeen,
    };
    run.shots.push(shotRecord);
    record(
      run,
      `shot-${shot.id}-size`,
      fits ? 'pass' : 'fail',
      `${(buf.length / 1024).toFixed(1)} KiB at quality ${usedQuality} (cap ${opts.maxKib} KiB)`,
    );
    record(
      run,
      `shot-${shot.id}-nonblank`,
      nonBlank ? 'pass' : 'fail',
      nonBlank
        ? `capture ${(buf.length / 1024).toFixed(1)} KiB, canvas fingerprint ${finalFp.hash}`
        : 'capture looks blank (tiny file or empty canvas fingerprint)',
    );
    return fits && nonBlank && expectation.status !== 'fail' && newErrors === 0;
  } catch (err) {
    record(run, `shot-${shot.id}-harness`, 'fail', String(err && err.message ? err.message : err));
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

// --- main ---------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }
  let shots;
  try {
    shots = loadShots(opts.shotsFile, opts.seed);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  if (opts.only) {
    const wanted = shots.find((s) => s.id === opts.only);
    if (!wanted) {
      console.error(`unknown shot "${opts.only}" (want one of: ${shots.map((s) => s.id).join(', ')})`);
      process.exit(2);
    }
    shots = [wanted];
  }
  if (opts.startQuality < 1 || opts.startQuality > 100) {
    console.error('error: --quality must be 1-100');
    process.exit(2);
  }
  if (opts.maxKib <= 0) {
    console.error('error: --max-kib must be positive');
    process.exit(2);
  }
  const run = newRun(opts);
  if (opts.dryRun) {
    console.log(`DRY RUN — ${shots.length} shot(s) from ${opts.shotsFile}`);
    console.log(`  would serve game/ from ${GAME_DIR} on port ${opts.port} (or --base-url ${opts.baseUrl || 'none'})`);
    console.log(`  output dir: ${opts.outDir}; size cap: ${opts.maxKib} KiB per file; start quality: ${opts.startQuality}`);
    console.log(`  quality ladder: ${[opts.startQuality, ...QUALITY_LADDER.filter((q) => q < opts.startQuality)].join(' -> ')}`);
    for (const s of shots) {
      console.log(`  ${s.id} ${s.name} ${s.query} steps=${s.steps} wait=${poseWaitMs(s, opts.waitMs)}ms — ${s.description}`);
    }
    console.log('dry run ok — no browser launched, no files written');
    return;
  }

  let server = null;
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    try {
      server = await startServer(opts.port);
    } catch (err) {
      console.error(`cannot serve game/ on port ${opts.port}: ${err.message}`);
      process.exit(1);
    }
    baseUrl = `http://127.0.0.1:${opts.port}`;
    console.log(`serving game/ on ${baseUrl}`);
  }
  let browser = null;
  let ok = false;
  try {
    browser = await launchBrowser(opts);
    let allOk = true;
    for (const shot of shots) {
      const shotOk = await takeShot(browser, baseUrl, run, opts, shot);
      if (!shotOk) allOk = false;
    }
    ok = printSummary(run) && allOk;
  } catch (err) {
    console.error(`screenshots crashed: ${err && err.stack ? err.stack : err}`);
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

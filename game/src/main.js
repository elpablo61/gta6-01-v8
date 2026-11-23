// main.js — the entry point of Crescent Bay.
//
// Boots the game, owns the frame loop and the shared `game` state, and
// wires every system module together. Each system module is imported as
// a namespace and called only through hooks it actually exposes: a
// module that exports `updateVehicles(game, dt)` is called through that
// hook, and one that does not is replaced by a small fallback here, so
// the game still runs while the modules are being finished. The fallback
// paths are marked FALLBACK and live only in this file.
//
// The shared state shape (also read by render.js and shots.js):
//   game.state      'title' | 'playing' | 'paused' | 'gameover' | 'dialog'
//   game.world      the built city (world.js)
//   game.camera     { x, y, width, height } — top-left of the view
//   game.player     { x, y, angle, speed, health, maxHealth, cash,
//                     onFoot, car, weaponName, ammo, weapons }
//   game.cars, game.pedestrians, game.police, game.enemies,
//   game.bullets, game.pickups, game.particles
//   game.helicopter { x, y, angle, smoking, spotlightX, spotlightY } | null
//   game.heat, game.stars, game.objective { text, x, y } | null
//   game.timeHour, game.daylight, game.radio { name, levels }
//   game.missionName, game.missionTimer, game.time
//
// Order of work each frame (the prose spec's hard-won lessons):
//   * the autopilot hook runs BEFORE the dialog branch, so it can press
//     E to accept a mission instead of deadlocking behind the dialog;
//   * manual driving is skipped on frames the autopilot drove, so the
//     two never fight over the same car;
//   * heat decays only while no police is within 450 for 3 seconds and
//     no helicopter spotlight is on Rook.
//
// Naming rules (never break): no Rockstar / GTA terms anywhere. The
// game-over screens say CAUGHT / DOWN. The repaint garage is the Spray
// Shop. The city is Crescent Bay, the character is Rook, the fixers are
// Mara and Dex.

import * as Config from './config.js';
import * as Random from './random.js';
import * as World from './world.js';
import * as Input from './input.js';
import * as Render from './render.js';
import * as Shots from './shots.js';
import * as Vehicles from './vehicles.js';
import * as Police from './police.js';
import * as Missions from './missions.js';
import * as Act2 from './act2.js';
import * as AudioMod from './audio.js';
import * as Garage from './garage.js';
import * as Helicopter from './helicopter.js';
import * as Radio from './radio.js';
import * as SaveMod from './save.js';
import * as Weapons from './weapons.js';

// Call the first hook a module exposes, with the given arguments.
// Returns the hook's value, or undefined when the module exposes none
// of the names.
function callHook(module, names, ...args) {
  for (const name of names) {
    const fn = module && module[name];
    if (typeof fn === 'function') return fn(...args);
  }
  return undefined;
}

function hasHook(module, names) {
  if (!module) return false;
  return names.some((name) => typeof module[name] === 'function');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SAVE_VERSION = 1;
export const SAVE_KEY_PREFIX = 'crescent-bay-save-';
export const SAVE_SLOT_COUNT = 3;

export const WANTED_THRESHOLDS = [0, 12, 30, 52, 74, 92];
export const HEAT_DECAY_DELAY = 3; // seconds with no police near
export const HEAT_DECAY_RADIUS = 450;
export const SPRAY_SHOP_RADIUS = 150;
export const SPRAY_SHOP_DRAIN = 50; // heat per second

export const WEAPON_DEFS = {
  pistol: { name: 'Pistol', damage: 18, rate: 0.28, pellets: 1, spread: 0.03, range: 520, startAmmo: 48 },
  smg: { name: 'SMG', damage: 10, rate: 0.09, pellets: 1, spread: 0.08, range: 420, startAmmo: 120 },
  shotgun: { name: 'Shotgun', damage: 8, rate: 0.7, pellets: 5, spread: 0.22, range: 260, startAmmo: 24 },
};
export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];

export const RADIO_STATIONS = [
  { id: 'bayfm', name: 'Bay FM', kind: 'synthwave' },
  { id: 'harbor', name: 'Harbor Jazz', kind: 'swing' },
  { id: 'rock', name: 'Crescent Rock', kind: 'rock' },
];

export const CAR_TYPES = {
  sedan: { topSpeed: 380, accel: 220, color: '#c0392b', length: 46, width: 22 },
  taxi: { topSpeed: 360, accel: 210, color: '#f1c40f', length: 46, width: 22 },
  truck: { topSpeed: 300, accel: 150, color: '#7f8c8d', length: 58, width: 26 },
  sports: { topSpeed: 520, accel: 320, color: '#8e44ad', length: 44, width: 21 },
  police: { topSpeed: 460, accel: 280, color: '#2c3e50', length: 48, width: 22 },
};

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

function newPlayerState() {
  return {
    x: 1000, y: 1400, angle: 0, speed: 0,
    health: 100, maxHealth: 100, cash: 250,
    onFoot: true, car: null,
    weapons: { pistol: { owned: true, ammo: WEAPON_DEFS.pistol.startAmmo } },
    currentWeapon: 'pistol',
    weaponName: 'Pistol',
    ammo: WEAPON_DEFS.pistol.startAmmo,
    fireCooldown: 0,
    color: '#1f8a70',
  };
}

function newGameState() {
  return {
    state: 'title',
    time: 0,
    timeHour: 11,
    daylight: 1,
    world: null,
    camera: { x: 0, y: 0, width: 1280, height: 900 },
    player: newPlayerState(),
    cars: [],
    pedestrians: [],
    police: [],
    enemies: [],
    bullets: [],
    pickups: [],
    particles: [],
    helicopter: null,
    heat: 0,
    stars: 0,
    hideTimer: 0,
    objective: null,
    missionName: null,
    missionTimer: null,
    missionId: null,
    radio: { name: RADIO_STATIONS[0].name, index: 0, levels: [0.4, 0.6, 0.3, 0.5, 0.4] },
    garageOpen: false,
    dialog: null,
    autopilotDrove: false,
    activeSlot: 1,
    muted: false,
    gameOverReason: null,
  };
}

export const game = newGameState();

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function showOverlay(id) {
  for (const name of ['title-screen', 'pause-menu', 'game-over-screen', 'mission-dialog', 'garage-menu']) {
    const node = el(name);
    if (node) node.classList.toggle('hidden', name !== id);
  }
}

function hideOverlays() {
  showOverlay(null);
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

// ---------------------------------------------------------------------------
// Saves — 3 versioned slots in localStorage (FALLBACK when save.js
// exposes no hook; the slot keys and shape are the contract either way)
// ---------------------------------------------------------------------------

export function saveSlotKey(slot) {
  return SAVE_KEY_PREFIX + slot;
}

export function readSlot(slot) {
  const stored = callHook(SaveMod, ['loadGame', 'readSlot'], slot);
  if (stored) return stored;
  try {
    const raw = localStorage.getItem(saveSlotKey(slot));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== SAVE_VERSION) return { corrupt: true, raw: true };
    return data;
  } catch (err) {
    return { corrupt: true };
  }
}

export function writeSlot(slot) {
  const data = {
    version: SAVE_VERSION,
    mission: game.missionId || 'm1',
    missionName: game.missionName || 'First Job',
    cash: Math.floor(game.player.cash),
    health: Math.floor(game.player.health),
    x: Math.floor(game.player.x),
    y: Math.floor(game.player.y),
    date: new Date().toISOString(),
  };
  if (hasHook(SaveMod, ['saveGame', 'writeSlot'])) {
    callHook(SaveMod, ['saveGame', 'writeSlot'], slot, data);
  } else {
    try {
      localStorage.setItem(saveSlotKey(slot), JSON.stringify(data));
    } catch (err) { /* storage full or blocked: the slot stays empty */ }
  }
  refreshSlotList();
  return data;
}

export function refreshSlotList() {
  const list = el('save-slots');
  if (!list) return;
  list.innerHTML = '';
  for (let slot = 1; slot <= SAVE_SLOT_COUNT; slot++) {
    const data = readSlot(slot);
    const button = document.createElement('button');
    button.className = 'save-slot';
    button.dataset.slot = String(slot);
    if (!data) {
      button.textContent = 'Slot ' + slot + ' — Empty';
    } else if (data.corrupt) {
      button.textContent = 'Slot ' + slot + ' — Corrupt (click to overwrite)';
    } else {
      const date = data.date ? new Date(data.date).toLocaleDateString() : '';
      button.textContent = 'Slot ' + slot + ' — ' + (data.missionName || data.mission) +
        ' · $' + (data.cash || 0) + ' · ' + date;
    }
    button.addEventListener('click', () => {
      game.activeSlot = slot;
      loadSlot(slot);
    });
    list.appendChild(button);
  }
}

export function loadSlot(slot) {
  const data = readSlot(slot);
  if (!data || data.corrupt) {
    startNewGame();
    return;
  }
  game.player.cash = data.cash || 0;
  game.player.health = data.health || 100;
  game.player.x = data.x || 1000;
  game.player.y = data.y || 1400;
  game.missionId = data.mission || 'm1';
  game.missionName = data.missionName || null;
  hideOverlays();
  game.state = 'playing';
}

// ---------------------------------------------------------------------------
// Radio — 3 procedural WebAudio stations (FALLBACK when radio.js exposes
// no hook). R cycles; the HUD shows the station name + equalizer.
// ---------------------------------------------------------------------------

let audioCtx = null;
let radioTimer = null;
let radioStep = 0;

const STATION_PATTERNS = {
  synthwave: { bpm: 112, bass: [0, 0, 7, 0, 5, 0, 7, 10], lead: [12, 15, 19, 15, 12, 10, 7, 10], wave: 'sawtooth' },
  swing: { bpm: 96, bass: [0, 7, 5, 7, 0, 7, 10, 7], lead: [12, 14, 16, 14, 12, 9, 7, 9], wave: 'triangle' },
  rock: { bpm: 132, bass: [0, 0, 3, 0, 5, 3, 7, 5], lead: [12, 12, 15, 12, 17, 15, 12, 10], wave: 'square' },
};

function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (err) {
      audioCtx = null;
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playNote(freq, when, duration, type, gainValue) {
  const ctx = audioCtx;
  if (!ctx || game.muted) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainValue, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + duration + 0.02);
}

function radioTick() {
  const station = RADIO_STATIONS[game.radio.index];
  const pattern = STATION_PATTERNS[station.kind];
  if (!pattern || !audioCtx || game.muted) return;
  const stepDur = 60 / pattern.bpm / 2;
  const now = audioCtx.currentTime + 0.05;
  const bassNote = 55 * Math.pow(2, pattern.bass[radioStep % 8] / 12);
  const leadNote = 220 * Math.pow(2, pattern.lead[radioStep % 8] / 12);
  playNote(bassNote, now, stepDur * 0.9, pattern.wave, 0.12);
  if (radioStep % 2 === 0) playNote(leadNote, now, stepDur * 0.8, 'sine', 0.05);
  game.radio.levels = [0.3, 0.5, 0.4, 0.6, 0.35].map((v, i) =>
    Math.max(0.1, Math.min(1, v * (0.7 + 0.6 * Math.abs(Math.sin(radioStep + i))))));
  radioStep++;
}

export function cycleRadioStation() {
  const next = callHook(Radio, ['cycleStation', 'nextStation'], game);
  if (next !== undefined && next !== null) {
    game.radio.name = typeof next === 'string' ? next : next.name;
    game.radio.index = (game.radio.index + 1) % RADIO_STATIONS.length;
  } else {
    game.radio.index = (game.radio.index + 1) % RADIO_STATIONS.length;
    game.radio.name = RADIO_STATIONS[game.radio.index].name;
  }
  setText('radio-station', '♪ ' + game.radio.name);
  if (typeof window !== 'undefined') {
    window.__crescentBay = window.__crescentBay || {};
    window.__crescentBay.radioStation = game.radio.name;
  }
}

function startRadio() {
  if (hasHook(Radio, ['startRadio', 'createRadio', 'initRadio'])) {
    callHook(Radio, ['startRadio', 'createRadio', 'initRadio'], game);
    return;
  }
  ensureAudio();
  if (radioTimer) return;
  radioTimer = setInterval(radioTick, 140);
}

// Small sound effects through the audio module when it has one, else a
// plain WebAudio blip here.
function sfx(kind) {
  if (hasHook(AudioMod, ['playSound', 'playSfx', 'sfx'])) {
    callHook(AudioMod, ['playSound', 'playSfx', 'sfx'], kind, game);
    return;
  }
  const ctx = ensureAudio();
  if (!ctx || game.muted) return;
  const freq = kind === 'shoot' ? 180 : kind === 'pickup' ? 660 : kind === 'hit' ? 90 : 440;
  playNote(freq, ctx.currentTime, 0.08, 'square', 0.06);
}

// ---------------------------------------------------------------------------
// Weapons — pistol / SMG / shotgun (FALLBACK when weapons.js exposes no
// hook). Keys 1/2/3 select, Q cycles, mouse aim + click shoots.
// ---------------------------------------------------------------------------

function currentWeaponDef() {
  return WEAPON_DEFS[game.player.currentWeapon];
}

function refreshWeaponHud() {
  const def = currentWeaponDef();
  game.player.weaponName = def.name;
  game.player.ammo = game.player.weapons[game.player.currentWeapon]
    ? game.player.weapons[game.player.currentWeapon].ammo : 0;
}

export function selectWeapon(id) {
  if (!game.player.weapons[id] || !game.player.weapons[id].owned) return;
  game.player.currentWeapon = id;
  refreshWeaponHud();
}

export function cycleWeapon() {
  const owned = WEAPON_ORDER.filter((id) => game.player.weapons[id] && game.player.weapons[id].owned);
  if (owned.length < 2) return;
  const at = owned.indexOf(game.player.currentWeapon);
  selectWeapon(owned[(at + 1) % owned.length]);
}

export function giveWeapon(id, ammo) {
  const def = WEAPON_DEFS[id];
  if (!def) return;
  if (!game.player.weapons[id]) game.player.weapons[id] = { owned: true, ammo: 0 };
  game.player.weapons[id].owned = true;
  game.player.weapons[id].ammo += ammo === undefined ? def.startAmmo : ammo;
  refreshWeaponHud();
}

function shootWeapon(angle) {
  const def = currentWeaponDef();
  const held = game.player.weapons[game.player.currentWeapon];
  if (!held || held.ammo <= 0 || game.player.fireCooldown > 0) return;
  game.player.fireCooldown = def.rate;
  held.ammo -= 1;
  refreshWeaponHud();
  sfx('shoot');
  for (let i = 0; i < def.pellets; i++) {
    const spread = (Math.random() - 0.5) * def.spread * 2;
    const a = angle + spread;
    game.bullets.push({
      x: game.player.x + Math.cos(a) * 20,
      y: game.player.y + Math.sin(a) * 20,
      angle: a,
      speed: 900,
      damage: def.damage,
      range: def.range,
      travelled: 0,
    });
  }
  // Gunfire scares nearby pedestrians.
  for (const ped of game.pedestrians) {
    const d = Math.hypot(ped.x - game.player.x, ped.y - game.player.y);
    if (d < 300) ped.fleeing = true;
  }
}

// ---------------------------------------------------------------------------
// Wanted / heat
// ---------------------------------------------------------------------------

export function starsForHeat(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED_THRESHOLDS.length; i++) {
    if (heat >= WANTED_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

export function addHeat(amount) {
  game.heat = Math.max(0, Math.min(100, game.heat + amount));
  game.stars = starsForHeat(game.heat);
}

export function setWanted(stars) {
  game.stars = Math.max(0, Math.min(5, stars));
  game.heat = WANTED_THRESHOLDS[game.stars];
}

function updateHeat(dt) {
  // The helicopter's spotlight blocks heat decay: hiding does not work
  // under it.
  const spotlightOn = game.helicopter && game.helicopter.spotlightX !== undefined &&
    Math.hypot(game.helicopter.spotlightX - game.player.x, game.helicopter.spotlightY - game.player.y) < 120;
  let policeNear = false;
  for (const cop of game.police) {
    if (Math.hypot(cop.x - game.player.x, cop.y - game.player.y) < HEAT_DECAY_RADIUS) {
      policeNear = true;
      break;
    }
  }
  if (policeNear || spotlightOn) {
    game.hideTimer = 0;
    return;
  }
  game.hideTimer += dt;
  if (game.hideTimer >= HEAT_DECAY_DELAY) {
    addHeat(-14 * dt);
  }
  // The Spray Shop clears heat fast while Rook sits inside it.
  const shop = World.LANDMARKS.sprayShop;
  if (Math.hypot(game.player.x - shop.x, game.player.y - shop.y) < SPRAY_SHOP_RADIUS) {
    addHeat(-SPRAY_SHOP_DRAIN * dt);
  }
}

// ---------------------------------------------------------------------------
// Helicopter (FALLBACK when helicopter.js exposes no hook)
// ---------------------------------------------------------------------------

function updateHelicopterFallback(dt) {
  if (game.stars < 3 && !game.helicopter) return;
  if (game.stars < 3 && game.helicopter) {
    game.helicopter = null;
    return;
  }
  if (!game.helicopter) {
    game.helicopter = {
      x: game.player.x + 300, y: game.player.y - 300,
      angle: 0, hp: 100, smoking: false, retreatTimer: 0,
      spotlightX: game.player.x, spotlightY: game.player.y, rotor: 0,
    };
  }
  const heli = game.helicopter;
  heli.rotor += dt * 20;
  if (heli.retreatTimer > 0) {
    heli.retreatTimer -= dt;
    heli.y -= 260 * dt;
    if (heli.retreatTimer <= 0) heli.hp = 100;
    return;
  }
  // Shadow Rook from above, faster than any car.
  const dx = game.player.x - heli.x;
  const dy = game.player.y - heli.y;
  const dist = Math.hypot(dx, dy) || 1;
  const speed = 560;
  heli.x += (dx / dist) * speed * dt;
  heli.y += (dy / dist) * speed * dt;
  heli.angle = Math.atan2(dy, dx);
  heli.shadowX = heli.x;
  heli.shadowY = heli.y;
  heli.spotlightX = game.player.x;
  heli.spotlightY = game.player.y;
  if (heli.hp <= 0) {
    heli.smoking = true;
    heli.retreatTimer = 20;
  }
}

// ---------------------------------------------------------------------------
// Traffic + pedestrians (FALLBACK when vehicles.js exposes no hook)
// ---------------------------------------------------------------------------

const TRAFFIC_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#ecf0f1', '#7f8c8d', '#16a085'];

function spawnTrafficFallback(count) {
  const rng = new Random.SeededRandom(Random.WORLD_SEED + 7);
  const types = ['sedan', 'taxi', 'truck', 'sports'];
  for (let i = 0; i < count; i++) {
    const type = rng.pick(types);
    const def = CAR_TYPES[type];
    const line = rng.pick(World.ROAD_LINES);
    const along = rng.range(200, 3000);
    const vertical = rng.chance(0.5);
    const start = World.nearestJunction(vertical ? line : along, vertical ? along : line);
    const goal = World.nearestJunction(rng.range(200, 3000), rng.range(200, 3000));
    game.cars.push({
      x: start.x, y: start.y, angle: 0, speed: 0,
      kind: type, type, color: rng.pick(TRAFFIC_COLORS),
      topSpeed: def.topSpeed * rng.range(0.6, 0.8),
      cruise: def.topSpeed * rng.range(0.55, 0.75),
      route: World.findRoute(start.x, start.y, goal.x, goal.y),
      routeIndex: 0,
      routeDest: { x: goal.x, y: goal.y },
      length: def.length, width: def.width,
      headlights: true, traffic: true,
    });
  }
}

function updateTrafficFallback(dt) {
  for (const car of game.cars) {
    if (!car.traffic || !car.route) continue;
    // Rebuild the route only when the destination moved far (never
    // every frame).
    if (car.routeIndex >= car.route.length) {
      const goal = World.nearestJunction(
        Random.trafficRandom.range(200, 3000), Random.trafficRandom.range(200, 3000));
      car.route = World.findRoute(car.x, car.y, goal.x, goal.y);
      car.routeIndex = 0;
      car.routeDest = { x: goal.x, y: goal.y };
      continue;
    }
    const target = car.route[car.routeIndex];
    const dx = target.x - car.x;
    const dy = target.y - car.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 12) {
      car.routeIndex++;
      continue;
    }
    const want = Math.atan2(dy, dx);
    let diff = want - car.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Radius steering: turn rate falls as speed rises.
    const turnRate = Math.max(1.2, 3.2 - car.speed / 300);
    car.angle += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));
    // Slow behind the car ahead.
    let cruise = car.cruise || 200;
    for (const other of game.cars) {
      if (other === car) continue;
      const ahead = (other.x - car.x) * Math.cos(car.angle) + (other.y - car.y) * Math.sin(car.angle);
      const side = Math.abs((other.x - car.x) * Math.sin(car.angle) - (other.y - car.y) * Math.cos(car.angle));
      if (ahead > 0 && ahead < 70 && side < 26) cruise = Math.min(cruise, other.speed * 0.9);
    }
    car.speed += Math.max(-260 * dt, Math.min(160 * dt, cruise - car.speed));
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
  }
}

function spawnPedestriansFallback(count) {
  const rng = new Random.SeededRandom(Random.WORLD_SEED + 21);
  const shirts = ['#4a7fb5', '#b54a6a', '#4ab57a', '#c9a227', '#7a5fb5', '#d0d0d0'];
  for (let i = 0; i < count; i++) {
    const line = rng.pick(World.ROAD_LINES);
    const along = rng.range(200, 3000);
    const vertical = rng.chance(0.5);
    game.pedestrians.push({
      x: vertical ? line + 44 : along,
      y: vertical ? along : line + 44,
      angle: rng.range(0, Math.PI * 2),
      color: '#e8e0d0',
      shirt: rng.pick(shirts),
      speed: rng.range(28, 62),
      fleeing: false,
    });
  }
}

function updatePedestriansFallback(dt) {
  for (const ped of game.pedestrians) {
    const speed = ped.fleeing ? ped.speed * 3 : ped.speed;
    ped.x += Math.cos(ped.angle) * speed * dt;
    ped.y += Math.sin(ped.angle) * speed * dt;
    // Stay on a sidewalk: wander along the nearest road.
    if (!World.isOnRoad(ped.x, ped.y) && Random.trafficRandom.chance(dt * 0.2)) {
      const near = World.nearestRoadPoint(ped.x, ped.y);
      ped.angle = Math.atan2(near.y - ped.y, near.x - ped.x);
    }
    if (ped.x < 100 || ped.x > 3100 || ped.y < 100 || ped.y > 3100) {
      ped.angle += Math.PI;
    }
    if (ped.fleeing && Math.hypot(ped.x - game.player.x, ped.y - game.player.y) > 400) {
      ped.fleeing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Police (FALLBACK when police.js exposes no hook)
// ---------------------------------------------------------------------------

function updatePoliceFallback(dt) {
  const wantFoot = game.stars >= 1 ? 2 : 0;
  const wantCars = game.stars >= 2 ? Math.min(4, game.stars) : 0;
  const foot = game.police.filter((c) => c.kind === 'foot').length;
  const cars = game.police.filter((c) => c.kind === 'car').length;
  for (let i = foot; i < wantFoot; i++) {
    game.police.push({
      kind: 'foot', x: game.player.x + 200, y: game.player.y + 120,
      angle: 0, speed: 0, color: '#2c4a7c', shirt: '#2c4a7c', arrestTimer: 0,
    });
  }
  for (let i = cars; i < wantCars; i++) {
    game.police.push({
      kind: 'car', x: game.player.x - 260, y: game.player.y,
      angle: 0, speed: 0, color: '#2c3e50', topSpeed: 460,
      cruise: 430, route: null, routeIndex: 0, length: 48, width: 22,
      headlights: true,
    });
  }
  for (const cop of game.police) {
    const dx = game.player.x - cop.x;
    const dy = game.player.y - cop.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (cop.kind === 'foot') {
      const speed = 150;
      cop.angle = Math.atan2(dy, dx);
      cop.x += (dx / dist) * speed * dt;
      cop.y += (dy / dist) * speed * dt;
      // Arrest: a foot cop must stay within 30 of a slow on-foot player
      // for 1.2 s in a row; running away breaks it.
      if (game.player.onFoot && dist < 30 && Math.abs(game.player.speed) < 60) {
        cop.arrestTimer += dt;
        if (cop.arrestTimer >= 1.2) endGame('CAUGHT');
      } else {
        cop.arrestTimer = 0;
      }
    } else {
      // Patrol cars chase along the road graph toward the player.
      if (!cop.route || Math.hypot((cop.routeDest || {}).x - game.player.x, (cop.routeDest || {}).y - game.player.y) > 100) {
        cop.route = World.findRoute(cop.x, cop.y, game.player.x, game.player.y);
        cop.routeIndex = 0;
        cop.routeDest = { x: game.player.x, y: game.player.y };
      }
      const target = cop.route[Math.min(cop.routeIndex, cop.route.length - 1)];
      if (target) {
        const tdx = target.x - cop.x;
        const tdy = target.y - cop.y;
        const tdist = Math.hypot(tdx, tdy);
        if (tdist < 14 && cop.routeIndex < cop.route.length - 1) cop.routeIndex++;
        const want = Math.atan2(tdy, tdx);
        let diff = want - cop.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        // A turn sharper than ~52 degrees: stop and rotate in place.
        if (Math.abs(diff) > 0.9) {
          cop.speed = 0;
          cop.angle += Math.max(-2.4 * dt, Math.min(2.4 * dt, diff));
        } else {
          const turnRate = Math.max(1.4, 3.0 - cop.speed / 300);
          cop.angle += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));
          cop.speed += Math.max(-300 * dt, Math.min(240 * dt, (cop.cruise || 420) - cop.speed));
        }
        cop.x += Math.cos(cop.angle) * cop.speed * dt;
        cop.y += Math.sin(cop.angle) * cop.speed * dt;
      }
    }
  }
  // Despawn cops that fell far behind and are no longer wanted.
  if (game.stars === 0) game.police.length = 0;
}

// ---------------------------------------------------------------------------
// Player: on foot and driving
// ---------------------------------------------------------------------------

function nearestCar(maxDist) {
  let best = null;
  let bestDist = maxDist;
  for (const car of game.cars) {
    const d = Math.hypot(car.x - game.player.x, car.y - game.player.y);
    if (d < bestDist) {
      bestDist = d;
      best = car;
    }
  }
  return best;
}

function updatePlayerOnFoot(dt, input) {
  const axis = input.moveAxis();
  const sprint = input.actionDown('sprint');
  const speed = sprint ? 260 : 150;
  const len = Math.hypot(axis.x, axis.y);
  if (len > 0.1) {
    game.player.x += (axis.x / len) * speed * dt;
    game.player.y += (axis.y / len) * speed * dt;
    game.player.angle = input.aimAngle(game.player.x, game.player.y);
    game.player.speed = speed;
  } else {
    game.player.speed = 0;
    game.player.angle = input.aimAngle(game.player.x, game.player.y);
  }
  const clamped = World.clampToWorld(game.player.x, game.player.y, 24);
  game.player.x = clamped.x;
  game.player.y = clamped.y;

  if (game.player.fireCooldown > 0) game.player.fireCooldown -= dt;
  if (input.actionDown('shoot') && game.player.onFoot) {
    shootWeapon(input.aimAngle(game.player.x, game.player.y));
  }

  // Enter a car, steal a parked car, or carjack a traffic car (the
  // driver flees).
  if (input.actionPressed('interact')) {
    const car = nearestCar(70);
    if (car) {
      game.player.car = car;
      game.player.onFoot = false;
      car.traffic = false;
      if (car.driverFlees !== false && car.occupied) {
        addHeat(6);
        game.pedestrians.push({
          x: car.x + 30, y: car.y + 30, angle: 0,
          color: '#e8e0d0', shirt: '#b54a6a', speed: 90, fleeing: true,
        });
      }
      car.occupied = true;
      sfx('pickup');
    }
  }
}

function updatePlayerDriving(dt, input) {
  const car = game.player.car;
  if (!car) {
    game.player.onFoot = true;
    return;
  }
  const axis = input.moveAxis();
  const upgrades = car.upgrades || { engine: 0, armor: 0, tires: 0, brakes: 0 };
  const def = CAR_TYPES[car.type] || CAR_TYPES.sedan;
  const topSpeed = (car.topSpeed || def.topSpeed) + upgrades.engine * 60;
  const brakePower = 420 + upgrades.brakes * 160;

  // Throttle / brake / reverse.
  if (axis.y < -0.1) {
    car.speed += (car.accel || def.accel) * dt;
  } else if (axis.y > 0.1) {
    car.speed -= brakePower * dt;
    if (car.speed < -120) car.speed = -120;
  } else {
    car.speed *= Math.max(0, 1 - 0.6 * dt);
    if (Math.abs(car.speed) < 4) car.speed = 0;
  }
  if (car.speed > topSpeed) car.speed = topSpeed;

  // Radius steering with a guaranteed minimum turn authority, even at
  // crawl speed; U-turns crawl at speed 60.
  const turnAuthority = (upgrades.tires * 0.25 + 1) * Math.max(0.5, Math.min(1.6, 140 / (Math.abs(car.speed) + 60)));
  car.angle += axis.x * turnAuthority * dt * Math.sign(car.speed || 1) * Math.min(1, Math.abs(car.speed) / 40 + 0.35);

  // Wall collision: slide along the wall instead of sticking, with wall
  // damage ticking at most once per 0.5 s (spec section 1).
  const nextX = car.x + Math.cos(car.angle) * car.speed * dt;
  const nextY = car.y + Math.sin(car.angle) * car.speed * dt;
  const now = game.time;
  if (nextX < 30 || nextX > World.WORLD_SIZE - 30 || nextY < 30 || nextY > World.WORLD_SIZE - 30) {
    if (!car.lastWallHit || now - car.lastWallHit > 0.5) {
      car.lastWallHit = now;
      damagePlayer(2);
    }
    car.speed *= 0.5;
  } else {
    car.x = nextX;
    car.y = nextY;
  }
  // Off-road: slow down hard until back on a road.
  if (!World.isOnRoad(car.x, car.y)) car.speed *= Math.max(0, 1 - 1.2 * dt);

  game.player.x = car.x;
  game.player.y = car.y;
  game.player.angle = car.angle;
  game.player.speed = car.speed;

  if (input.actionPressed('interact')) {
    game.player.car = null;
    game.player.onFoot = true;
    game.player.x = car.x + Math.cos(car.angle + Math.PI / 2) * 30;
    game.player.y = car.y + Math.sin(car.angle + Math.PI / 2) * 30;
    game.player.speed = 0;
  }
}

function damagePlayer(amount) {
  const armor = game.player.car && game.player.car.upgrades ? game.player.car.upgrades.armor || 0 : 0;
  const taken = amount * (1 - armor * 0.15);
  game.player.health = Math.max(0, game.player.health - taken);
  if (game.player.health <= 0) endGame('DOWN');
}

function updateBullets(dt) {
  for (let i = game.bullets.length - 1; i >= 0; i--) {
    const b = game.bullets[i];
    b.x += Math.cos(b.angle) * b.speed * dt;
    b.y += Math.sin(b.angle) * b.speed * dt;
    b.travelled += b.speed * dt;
    let dead = b.travelled > b.range || b.x < 0 || b.x > World.WORLD_SIZE || b.y < 0 || b.y > World.WORLD_SIZE;
    if (!dead) {
      for (const enemy of game.enemies) {
        if (Math.hypot(enemy.x - b.x, enemy.y - b.y) < 18) {
          enemy.hp -= b.damage;
          sfx('hit');
          game.particles.push({ x: b.x, y: b.y, color: '#ff6b5e', size: 6, life: 0.5 });
          if (enemy.hp <= 0) {
            game.enemies.splice(game.enemies.indexOf(enemy), 1);
            game.player.cash += 50;
          }
          dead = true;
          break;
        }
      }
    }
    if (!dead && game.helicopter) {
      const heli = game.helicopter;
      if (Math.hypot(heli.x - b.x, heli.y - b.y) < 40) {
        heli.hp -= b.damage;
        if (heli.hp <= 0 && !heli.smoking) {
          heli.smoking = true;
          heli.retreatTimer = 20;
        }
        dead = true;
      }
    }
    if (dead) game.bullets.splice(i, 1);
  }
  for (let i = game.particles.length - 1; i >= 0; i--) {
    game.particles[i].life -= dt * 2;
    if (game.particles[i].life <= 0) game.particles.splice(i, 1);
  }
}

function updatePickups(dt) {
  for (let i = game.pickups.length - 1; i >= 0; i--) {
    const p = game.pickups[i];
    p.bob = (p.bob || 0) + dt * 3;
    if (Math.hypot(p.x - game.player.x, p.y - game.player.y) < 34) {
      if (p.kind === 'health') {
        game.player.health = Math.min(game.player.maxHealth, game.player.health + 30);
      } else if (p.kind === 'ammo') {
        const held = game.player.weapons[game.player.currentWeapon];
        if (held) held.ammo += 24;
        refreshWeaponHud();
      } else if (p.kind === 'crate' && p.weapon) {
        giveWeapon(p.weapon);
      }
      sfx('pickup');
      game.pickups.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Missions — the 12-mission arc (FALLBACK: free-roam objectives when the
// mission modules expose no hook). The arc itself lives in missions.js
// (m1–m8) and act2.js (m9–m12); main.js only starts, ticks and completes
// through their hooks, and falls back to a simple marker objective.
// ---------------------------------------------------------------------------

export const MISSION_LIST = [
  { id: 'm1', name: 'First Job', fixer: 'Mara', reward: 400, limit: 300 },
  { id: 'm2', name: 'Tail Chase', fixer: 'Mara', reward: 700, limit: 300 },
  { id: 'm3', name: 'Hot Wheels', fixer: 'Dex', reward: 900, limit: 240 },
  { id: 'm4', name: 'Dockside', fixer: 'Mara', reward: 1100, limit: 360 },
  { id: 'm5', name: 'Midnight Run', fixer: 'Dex', reward: 1400, limit: 300 },
  { id: 'm6', name: 'Collector', fixer: 'Mara', reward: 1800, limit: 420 },
  { id: 'm7', name: 'Highway Heat', fixer: 'Dex', reward: 4600, limit: 420 },
  { id: 'm8', name: 'Crescent Job', fixer: 'Mara', reward: 6200, limit: 600 },
  { id: 'm9', name: 'Sky Watch', fixer: 'Dex', reward: 2000, limit: 420 },
  { id: 'm10', name: 'Full Auto', fixer: 'Mara', reward: 2500, limit: 420 },
  { id: 'm11', name: 'Tune-Up', fixer: 'Dex', reward: 3000, limit: 420 },
  { id: 'm12', name: 'Bay Finale', fixer: 'Mara', reward: 8000, limit: 600 },
];

export function startMission(id) {
  const started = callHook(Missions, ['startMission'], id, game) ??
    callHook(Act2, ['startMission', 'startAct2Mission'], id, game);
  if (started === false) return false;
  const def = MISSION_LIST.find((m) => m.id === id);
  if (!def) return false;
  game.missionId = id;
  game.missionName = def.name;
  game.missionTimer = def.limit;
  // m7: the wanted cover starts at 3 stars once the mission starts —
  // set the cover AFTER the mission starts, because the mission itself
  // adds heat on start.
  if (id === 'm7' || id === 'm9') setWanted(3);
  if (id === 'm12') setWanted(4);
  openMissionDialog(def.fixer, missionHookText(def));
  return true;
}

function missionHookText(def) {
  const hooks = {
    m1: 'Pick up the package at the market, then deliver it downtown. $400 when it is done.',
    m2: 'A courier is running product across town. Ram his car four times and he will talk. $700.',
    m3: 'Three checkpoints — the club, the marina, the airport — before the clock runs out. $900.',
    m4: 'A crate is waiting at the marina. Bring it to the hideout. The docks are hot. $1,100.',
    m5: 'Night run. Pick up at the club, drop at the docks. Keep the headlights on. $1,400.',
    m6: 'Five money drops around the city. Collect them all, then come home. $1,800.',
    m7: 'Drive to the airport, then lose the police. They will be waiting. $4,600.',
    m8: 'The Crescent Job. Three of them in the arena — take them down, then run. $6,200.',
    m9: 'The helicopter is up and it is not leaving. Reach the hideout while it watches. $2,000.',
    m10: 'Dockside shootout, five of them. There are weapon crates in the arena — use them. $2,500.',
    m11: 'Drive to the Fixer Garage, buy an upgrade, then run three checkpoints in the tuned car. $3,000.',
    m12: 'The Bay Finale. Hit the bank, grab the loot, lose the helicopter and the roadblocks, reach the plane. $8,000.',
  };
  return hooks[def.id] || def.name;
}

export function completeMission() {
  const def = MISSION_LIST.find((m) => m.id === game.missionId);
  if (def) {
    game.player.cash += def.reward;
    const nextIndex = MISSION_LIST.findIndex((m) => m.id === def.id) + 1;
    game.missionId = nextIndex < MISSION_LIST.length ? MISSION_LIST[nextIndex].id : null;
  }
  game.missionName = null;
  game.missionTimer = null;
  game.objective = null;
  writeSlot(game.activeSlot); // autosave after each mission
  sfx('pickup');
}

function updateMissionFallback(dt) {
  if (game.missionTimer === null || game.missionTimer === undefined) return;
  game.missionTimer -= dt;
  if (game.missionTimer <= 0) {
    // A failed mission restarts from its stage 0.
    startMission(game.missionId || 'm1');
  }
}

// ---------------------------------------------------------------------------
// Garage — the Fixer Garage upgrade menu (FALLBACK when garage.js exposes
// no hook). Drive into the zone and press E to open; the world pauses.
// ---------------------------------------------------------------------------

export const GARAGE_UPGRADES = [
  { id: 'engine', name: 'Engine', levels: 3, prices: [800, 1500, 2500] },
  { id: 'armor', name: 'Armor', levels: 3, prices: [500, 1000, 1800] },
  { id: 'tires', name: 'Tires', levels: 2, prices: [400, 900] },
  { id: 'brakes', name: 'Brakes', levels: 2, prices: [400, 900] },
];
export const GARAGE_PAINTS = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad', '#ecf0f1'];

export function openGarageMenu() {
  if (!game.player.car) return;
  if (hasHook(Garage, ['openGarage', 'openGarageMenu'])) {
    callHook(Garage, ['openGarage', 'openGarageMenu'], game);
    game.garageOpen = true;
    return;
  }
  game.garageOpen = true;
  game.state = 'paused';
  const menu = el('garage-menu');
  const list = el('garage-upgrades');
  if (menu) menu.classList.remove('hidden');
  if (!list) return;
  list.innerHTML = '';
  const car = game.player.car;
  car.upgrades = car.upgrades || { engine: 0, armor: 0, tires: 0, brakes: 0 };
  for (const up of GARAGE_UPGRADES) {
    const level = car.upgrades[up.id] || 0;
    const row = document.createElement('div');
    row.className = 'garage-row';
    if (level >= up.levels) {
      row.textContent = up.name + ' — MAX';
    } else {
      const price = up.prices[level];
      const button = document.createElement('button');
      button.textContent = up.name + ' Lv ' + (level + 1) + ' — $' + price;
      button.addEventListener('click', () => buyUpgrade(up.id));
      row.appendChild(button);
    }
    list.appendChild(row);
  }
  const paintRow = document.createElement('div');
  paintRow.className = 'garage-row';
  paintRow.textContent = 'Paint — $150: ';
  for (const color of GARAGE_PAINTS) {
    const swatch = document.createElement('button');
    swatch.className = 'paint-swatch';
    swatch.style.background = color;
    swatch.addEventListener('click', () => buyPaint(color));
    paintRow.appendChild(swatch);
  }
  list.appendChild(paintRow);
  setText('garage-cash', 'Cash: $' + Math.floor(game.player.cash));
}

export function buyUpgrade(id) {
  const up = GARAGE_UPGRADES.find((u) => u.id === id);
  const car = game.player.car;
  if (!up || !car) return false;
  car.upgrades = car.upgrades || { engine: 0, armor: 0, tires: 0, brakes: 0 };
  const level = car.upgrades[id] || 0;
  if (level >= up.levels) return false;
  const price = up.prices[level];
  if (game.player.cash < price) return false;
  if (hasHook(Garage, ['buyUpgrade'])) {
    const ok = callHook(Garage, ['buyUpgrade'], id, game);
    if (ok === false) return false;
  }
  game.player.cash -= price;
  car.upgrades[id] = level + 1;
  game.missionGaragePurchase = true;
  sfx('pickup');
  openGarageMenu();
  return true;
}

export function buyPaint(color) {
  if (!game.player.car || game.player.cash < 150) return false;
  game.player.cash -= 150;
  game.player.car.color = color;
  sfx('pickup');
  openGarageMenu();
  return true;
}

export function closeGarageMenu() {
  game.garageOpen = false;
  const menu = el('garage-menu');
  if (menu) menu.classList.add('hidden');
  if (game.state === 'paused') game.state = 'playing';
}

// ---------------------------------------------------------------------------
// Dialogs, pause, game over, new game
// ---------------------------------------------------------------------------

export function openMissionDialog(fixer, text) {
  game.dialog = { fixer, text };
  game.state = 'dialog';
  setText('dialog-fixer', fixer);
  setText('dialog-text', text);
  showOverlay('mission-dialog');
}

export function acceptDialog() {
  game.dialog = null;
  hideOverlays();
  game.state = 'playing';
}

export function togglePause() {
  if (game.state === 'playing') {
    game.state = 'paused';
    showOverlay('pause-menu');
  } else if (game.state === 'paused') {
    game.state = 'playing';
    hideOverlays();
  }
}

export function endGame(reason) {
  game.gameOverReason = reason;
  game.state = 'gameover';
  setText('game-over-title', reason === 'CAUGHT' ? 'CAUGHT' : 'DOWN');
  setText('game-over-text', reason === 'CAUGHT'
    ? 'The police took Rook in. The crew will post bail — try the job again.'
    : 'Rook is down. The crew drags him out — try the job again.');
  showOverlay('game-over-screen');
  sfx('hit');
}

export function startNewGame() {
  const fresh = newGameState();
  Object.assign(game, fresh);
  game.state = 'playing';
  hideOverlays();
  buildWorld();
  startRadio();
  setText('radio-station', '♪ ' + game.radio.name);
  startMission('m1');
}

// ---------------------------------------------------------------------------
// World building
// ---------------------------------------------------------------------------

let renderer = null;
let input = null;

function buildWorld() {
  const world = World.createWorld(Random.WORLD_SEED);
  game.world = world;
  if (renderer) renderer.buildStaticLayer(world);
  game.cars.length = 0;
  game.pedestrians.length = 0;
  game.police.length = 0;
  game.enemies.length = 0;
  game.pickups.length = 0;
  game.bullets.length = 0;
  // Parked cars in the bays, plus traffic on the roads.
  const rng = new Random.SeededRandom(Random.WORLD_SEED + 33);
  for (const bay of world.parkedBays.slice(0, 24)) {
    const type = rng.pick(['sedan', 'taxi', 'truck', 'sports']);
    const def = CAR_TYPES[type];
    game.cars.push({
      x: bay.x, y: bay.y, angle: 0, speed: 0,
      kind: type, type, color: rng.pick(TRAFFIC_COLORS),
      topSpeed: def.topSpeed, cruise: 0,
      length: def.length, width: def.width,
      headlights: false, traffic: false, parked: true,
    });
  }
  if (hasHook(Vehicles, ['createTraffic', 'spawnTraffic', 'updateVehicles'])) {
    callHook(Vehicles, ['createTraffic', 'spawnTraffic'], game);
  } else {
    spawnTrafficFallback(14);
  }
  spawnPedestriansFallback(26);
  // Weapon crates at fixed spots: gun store, docks, hideout.
  game.pickups.push(
    { x: World.LANDMARKS.gunStore.x, y: World.LANDMARKS.gunStore.y, kind: 'crate', weapon: 'smg', label: 'SMG' },
    { x: World.LANDMARKS.docks.x, y: World.LANDMARKS.docks.y, kind: 'crate', weapon: 'shotgun', label: 'SG' },
    { x: World.LANDMARKS.hideout.x, y: World.LANDMARKS.hideout.y, kind: 'crate', weapon: 'smg', label: 'SMG' },
    { x: World.LANDMARKS.hideout.x + 60, y: World.LANDMARKS.hideout.y, kind: 'health' },
    { x: World.LANDMARKS.gunStore.x + 60, y: World.LANDMARKS.gunStore.y, kind: 'ammo' },
  );
  // The player starts at the hideout.
  game.player.x = World.LANDMARKS.hideout.x;
  game.player.y = World.LANDMARKS.hideout.y;
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function updateCamera(dt) {
  void dt;
  const canvas = renderer.canvas;
  const viewHeight = 900;
  const viewWidth = viewHeight * (canvas.width / canvas.height);
  game.camera.width = viewWidth;
  game.camera.height = viewHeight;
  game.camera.x = game.player.x - viewWidth / 2;
  game.camera.y = game.player.y - viewHeight / 2;
  game.camera.x = Math.max(0, Math.min(World.WORLD_SIZE - viewWidth, game.camera.x));
  game.camera.y = Math.max(0, Math.min(World.WORLD_SIZE - viewHeight, game.camera.y));
  if (input) {
    input.setMouseWorld(
      game.camera.x + (input.mouseX / canvas.width) * viewWidth,
      game.camera.y + (input.mouseY / canvas.height) * viewHeight,
    );
  }
}

function update(dt) {
  game.time += dt;
  // Day / night clock.
  game.timeHour = (game.timeHour + (dt / World.DAY_LENGTH_SECONDS) * 24) % 24;
  game.daylight = World.daylightAt(game.timeHour);

  // The autopilot hook runs BEFORE the dialog branch, so it can press E
  // to accept a mission (a dialog-first order deadlocked an earlier
  // build). No autopilot module ships in this repo yet; when one does,
  // it hooks in here through window.__crescentBay.autopilot.
  const autopilot = typeof window !== 'undefined' ? window.__crescentBay?.autopilot : null;
  if (typeof autopilot === 'function') {
    game.autopilotDrove = autopilot(game, dt, input) === true;
  } else {
    game.autopilotDrove = false;
  }

  // Dialog: only the accept key matters; the world waits.
  if (game.state === 'dialog') {
    if (input.actionPressed('interact')) acceptDialog();
    return;
  }
  if (game.state !== 'playing') return;

  // Pause / radio / weapon keys.
  if (input.actionPressed('pause')) {
    togglePause();
    return;
  }
  if (input.actionPressed('radio')) cycleRadioStation();
  if (input.actionPressed('mute')) {
    game.muted = !game.muted;
  }
  if (input.actionPressed('weapon1')) selectWeapon('pistol');
  if (input.actionPressed('weapon2')) selectWeapon('smg');
  if (input.actionPressed('weapon3')) selectWeapon('shotgun');
  if (input.actionPressed('cycleWeapon')) cycleWeapon();

  // Garage: drive into the zone and press E.
  const garage = World.LANDMARKS.fixerGarage;
  if (input.actionPressed('interact') && !game.player.onFoot &&
    Math.hypot(game.player.x - garage.x, game.player.y - garage.y) < 120) {
    openGarageMenu();
    return;
  }

  // Player movement — skipped on frames the autopilot drove, so manual
  // driving never brakes the autopilot's car back to zero.
  if (!game.autopilotDrove) {
    if (game.player.onFoot) updatePlayerOnFoot(dt, input);
    else updatePlayerDriving(dt, input);
  }

  // Systems, each through its module hook when one exists.
  if (hasHook(Vehicles, ['updateVehicles', 'update', 'updateTraffic'])) {
    callHook(Vehicles, ['updateVehicles', 'update', 'updateTraffic'], game, dt);
  } else {
    updateTrafficFallback(dt);
  }
  updatePedestriansFallback(dt);
  if (hasHook(Police, ['updatePolice', 'update'])) {
    callHook(Police, ['updatePolice', 'update'], game, dt);
  } else {
    updatePoliceFallback(dt);
  }
  if (hasHook(Helicopter, ['updateHelicopter', 'update'])) {
    callHook(Helicopter, ['updateHelicopter', 'update'], game, dt);
  } else {
    updateHelicopterFallback(dt);
  }
  if (hasHook(Weapons, ['updateWeapons', 'update'])) {
    callHook(Weapons, ['updateWeapons', 'update'], game, dt);
  }
  if (hasHook(Missions, ['updateMissions', 'update'])) {
    callHook(Missions, ['updateMissions', 'update'], game, dt);
  } else if (hasHook(Act2, ['updateAct2', 'update'])) {
    callHook(Act2, ['updateAct2', 'update'], game, dt);
  } else {
    updateMissionFallback(dt);
  }
  updateBullets(dt);
  updatePickups(dt);
  updateHeat(dt);
  updateCamera(dt);
}

let lastTimestamp = 0;

function frame(timestamp) {
  const dt = Math.min(0.05, lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 0.016);
  lastTimestamp = timestamp;
  if (game.state === 'title') {
    // The title screen shows the living city behind it.
    game.time += dt;
    game.timeHour = (game.timeHour + (dt / World.DAY_LENGTH_SECONDS) * 24) % 24;
    game.daylight = World.daylightAt(game.timeHour);
    updateTrafficFallback(dt);
    updatePedestriansFallback(dt);
    updateCamera(dt);
  } else {
    update(dt);
  }
  if (renderer) renderer.render(game, dt);
  if (input) input.update();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  const canvas = el('game-canvas');
  if (!canvas) return;
  renderer = Render.createRenderer(canvas);
  input = Input.createInput(canvas);
  input.attach();

  const resize = () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();

  buildWorld();
  refreshWeaponHud();
  refreshSlotList();
  setText('radio-station', '♪ ' + game.radio.name);

  // Title screen buttons.
  const newGameBtn = el('new-game-btn');
  if (newGameBtn) newGameBtn.addEventListener('click', () => { startNewGame(); });
  const resumeBtn = el('resume-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => togglePause());
  const saveBtn = el('save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => { writeSlot(game.activeSlot); });
  const quitBtn = el('quit-btn');
  if (quitBtn) quitBtn.addEventListener('click', () => {
    game.state = 'title';
    refreshSlotList();
    showOverlay('title-screen');
  });
  const quitBtn2 = el('quit-btn-2');
  if (quitBtn2) quitBtn2.addEventListener('click', () => {
    game.state = 'title';
    refreshSlotList();
    showOverlay('title-screen');
  });
  const retryBtn = el('retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', () => { startMission(game.missionId || 'm1'); });
  const dialogAccept = el('dialog-accept');
  if (dialogAccept) dialogAccept.addEventListener('click', () => acceptDialog());
  const dialogDecline = el('dialog-decline');
  if (dialogDecline) dialogDecline.addEventListener('click', () => acceptDialog());
  const garageClose = el('garage-close');
  if (garageClose) garageClose.addEventListener('click', () => closeGarageMenu());

  // Screenshot + playtest hooks.
  Shots.registerShotHooks({
    setTimeOfDay: (hour) => { game.timeHour = hour; game.daylight = World.daylightAt(hour); },
    setWanted: (stars) => setWanted(stars),
    placePlayer: (x, y, opts) => {
      game.player.x = x;
      game.player.y = y;
      if (opts && opts.inCar) {
        const car = nearestCar(400) || game.cars[0];
        if (car) {
          game.player.car = car;
          game.player.onFoot = false;
          car.x = x;
          car.y = y;
        }
      } else {
        game.player.car = null;
        game.player.onFoot = true;
      }
      game.state = 'playing';
      hideOverlays();
    },
    spawnPoliceChase: (count) => {
      setWanted(3);
      for (let i = 0; i < count; i++) {
        game.police.push({
          kind: 'car', x: game.player.x - 200 - i * 80, y: game.player.y + (i - 1) * 60,
          angle: 0, speed: 300, color: '#2c3e50', topSpeed: 460,
          cruise: 430, route: null, routeIndex: 0, length: 48, width: 22,
          headlights: true,
        });
      }
    },
    spawnEnemies: (count, x, y) => {
      for (let i = 0; i < count; i++) {
        game.enemies.push({
          x: x + 120 + i * 60, y: y - 40 + i * 40,
          angle: Math.PI, hp: 36, maxHp: 36, color: '#d8d8d8',
        });
      }
    },
    spawnRoadblock: (x, y) => {
      for (let i = -1; i <= 1; i++) {
        game.police.push({
          kind: 'car', x: x + i * 60, y, angle: Math.PI / 2, speed: 0,
          color: '#2c3e50', topSpeed: 0, cruise: 0, route: null,
          routeIndex: 0, length: 48, width: 22, headlights: true, roadblock: true,
        });
      }
    },
    setObjective: (text, x, y) => { game.objective = { text, x, y }; },
    openMissionDialog: (fixer, text) => openMissionDialog(fixer, text),
    showTitleScreen: () => {
      game.state = 'title';
      refreshSlotList();
      showOverlay('title-screen');
    },
  });

  // The handle playtests, the screenshot tool and the finisher use.
  window.__crescentBay = {
    game,
    version: 'v8',
    startMission,
    completeMission,
    setWanted,
    addHeat,
    cycleRadioStation,
    selectWeapon,
    giveWeapon,
    writeSlot,
    loadSlot,
    startNewGame,
    endGame,
    openGarageMenu,
    closeGarageMenu,
    buyUpgrade,
    shots: Shots.createShotHandle(),
    get radioStation() { return game.radio.name; },
    autopilot: null, // set by the autopilot module / playtest harness
  };

  showOverlay('title-screen');
  updateCamera(0);
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

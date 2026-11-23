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
import * as Traffic from './traffic.js';
import * as Pedestrians from './pedestrians.js';
import * as Combat from './combat.js';
import * as PlayerMod from './player.js';
import * as Autopilot from './autopilot.js';
import * as Hud from './hud.js';
import * as LivingCity from './living-city.js';

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
// G/H module wiring (finisher) — one shared context object `gctx` that
// carries every field the Builder G factories (createX(G)) and the
// Builder H systems (world.*) need. Instances are created in
// wireGModules() after buildWorld(), so factories see the real city.
// ---------------------------------------------------------------------------

let gctx = null;
let gAudio = null;
let gTraffic = null;
let gPeds = null;
let gCombat = null;
let gPlayer = null;
let gAutopilot = null;
let gHud = null;
let gHeli = null;
let gGarage = null;
let gWeapons = null;
let gSave = null;
let gPoliceDept = null;
let gWanted = null;
let gCourierCar = null; // m2 chase target (a live traffic car)
let gSyncedCrates = new Set();
let gCombatWrapped = null; // proxy: applies fire() hit records as damage

// combat.fire() RETURNS hit records ({target, damage, x, y, killed})
// but applies no damage itself — the caller must. Every fire path
// (player module, autopilot, main's shootWeapon) goes through here.
function applyCombatHits(hits) {
  if (!hits || !hits.length) return;
  for (const hit of hits) {
    const t = hit.target || hit.enemy;
    if (!t || typeof t.hp !== 'number') continue;
    t.hp -= hit.damage || 0;
    try { sfx('hit'); } catch (err) { /* sfx is best-effort */ }
    game.particles.push({
      x: hit.x !== undefined ? hit.x : t.x,
      y: hit.y !== undefined ? hit.y : t.y,
      color: '#ff6b5e', size: 6, life: 0.5,
    });
    if (t.hp <= 0) {
      const i = game.enemies.indexOf(t);
      if (i >= 0) game.enemies.splice(i, 1);
      game.player.cash += 50;
      if (typeof Act2.act2OnEnemyDown === 'function' && isAct2Mission(game.missionId)) {
        try { Act2.act2OnEnemyDown(game, t); } catch (err) { /* best-effort */ }
      }
    }
  }
}

function fireCombat(ox, oy, angle, targets) {
  if (!gCombat || typeof gCombat.fire !== 'function') return [];
  let hits = [];
  try {
    hits = gCombat.fire(ox, oy, angle, targets) || [];
  } catch (err) {
    return [];
  }
  applyCombatHits(hits);
  return hits;
}

function makeCombatWrapper(combat) {
  if (!combat) return null;
  const wrappedFire = (ox, oy, angle, targets) => fireCombat(ox, oy, angle, targets);
  return new Proxy(combat, {
    get(target, prop) {
      if (prop === 'fire') return wrappedFire;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function instantiate(module, factoryNames, ctx) {
  if (!module) return null;
  for (const name of factoryNames) {
    const fn = module[name];
    if (typeof fn === 'function') {
      try {
        const inst = ctx === undefined ? fn() : fn(ctx);
        return inst === undefined ? null : inst;
      } catch (err) {
        console.warn('[wiring] factory ' + name + ' failed:', err && err.message);
        return null;
      }
    }
  }
  return null;
}

function callInstance(inst, names, ...args) {
  if (!inst) return false;
  for (const name of names) {
    const fn = inst[name];
    if (typeof fn === 'function') {
      fn.apply(inst, args);
      return true;
    }
  }
  return false;
}

function minimapPoints() {
  const pts = [];
  if (game.objective) pts.push({ x: game.objective.x, y: game.objective.y, kind: 'objective', label: game.objective.text || 'Objective' });
  for (const cop of game.police) pts.push({ x: cop.x, y: cop.y, kind: 'police' });
  const shop = World.LANDMARKS.sprayShop;
  pts.push({ x: shop.x, y: shop.y, kind: 'spray' });
  const garage = World.LANDMARKS.fixerGarage;
  pts.push({ x: garage.x, y: garage.y, kind: 'garage' });
  return pts;
}

function buildGContext() {
  const ctx = {
    game,
    get player() { return game.player; },
    get world() { return game.world; },
    get cars() { return game.cars; },
    get pedestrians() { return game.pedestrians; },
    get bullets() { return game.bullets; },
    get pickups() { return game.pickups; },
    get enemies() { return game.enemies; },
    get police() { return game.police; },
    get traffic() { return gTraffic; },
    get combat() { return gCombatWrapped || gCombat; },
    get autopilot() { return gAutopilot; },
    get helicopter() {
      return {
        get active() { return gHeli ? !!gHeli.active : !!game.helicopter; },
        get spotlightOnPlayer() { return gHeli ? !!gHeli.spotOn : false; },
        get x() { return game.helicopter ? game.helicopter.x : 0; },
        get y() { return game.helicopter ? game.helicopter.y : 0; },
        get spotlightX() { return game.helicopter ? game.helicopter.spotlightX : undefined; },
        get spotlightY() { return game.helicopter ? game.helicopter.spotlightY : undefined; },
      };
    },
    get garage() {
      return {
        get x() { return World.LANDMARKS.fixerGarage.x; },
        get y() { return World.LANDMARKS.fixerGarage.y; },
        open: () => openGarageMenu(),
        buyCheapest: () => buyCheapestUpgrade(),
        close: () => closeGarageMenu(),
      };
    },
    get sprayShop() { return { x: World.LANDMARKS.sprayShop.x, y: World.LANDMARKS.sprayShop.y }; },
    get courier() {
      // The autopilot's chase steering aims at this, NOT at the
      // setObjective point — so a phantom fallback point (the old
      // 1500,1500) would send it parking next to nothing. With no
      // courier, report the player's own position so it idles.
      // LEAD the courier by 120px along its heading: pure pursuit of
      // the courier's current position makes the car orbit behind a
      // moving target forever (it slows near the target and never
      // closes); aiming ahead intercepts it.
      return {
        get x() {
          if (!gCourierCar) return game.player.x;
          const a = gCourierCar.angle || 0;
          return gCourierCar.x + Math.cos(a) * 120;
        },
        get y() {
          if (!gCourierCar) return game.player.y;
          const a = gCourierCar.angle || 0;
          return gCourierCar.y + Math.sin(a) * 120;
        },
        get car() { return gCourierCar; },
      };
    },
    get dialogOpen() { return game.state === 'dialog'; },
    get audio() { return gAudio; },
    get wanted() { return gWanted; },
    get policeDept() { return gPoliceDept; },
    combatTargets: () => game.enemies,
    targets: () => game.enemies,
    minimap: { points: () => minimapPoints() },
    minimapPoints: () => minimapPoints(),
    wantedStars: () => game.stars,
    get garageX() { return World.LANDMARKS.fixerGarage.x; },
    get garageY() { return World.LANDMARKS.fixerGarage.y; },
    playerCar: () => game.player.car,
    get cash() { return game.player.cash; },
    set cash(v) { game.player.cash = v; },
    addCash: (n) => { game.player.cash += n; },
    setPaused: (b) => {
      if (b) { game.state = 'paused'; }
      else if (game.state === 'paused') { game.state = 'playing'; }
    },
    setObjective: (obj) => setArcObjective(obj),
    addHeat: (n) => addHeat(n),
    get input() { return input; },
    spots: [
      { x: World.LANDMARKS.gunStore.x, y: World.LANDMARKS.gunStore.y, weapon: 'smg' },
      { x: World.LANDMARKS.docks.x, y: World.LANDMARKS.docks.y, weapon: 'shotgun' },
      { x: World.LANDMARKS.hideout.x, y: World.LANDMARKS.hideout.y, weapon: 'smg' },
    ],
  };
  return ctx;
}

// Attach the collision + world helpers the G/H contracts expect onto
// the live world object (runtime wiring, not a source edit).
function attachWorldHelpers() {
  const w = game.world;
  if (!w || w.__crescentWired) return;
  w.__crescentWired = true;
  w.collide = (x, y, r) => World.clampToWorld(x, y, r === undefined ? 24 : r);
  Object.defineProperty(w, 'player', { get: () => game.player, configurable: true });
  w.wantedStars = () => game.stars;
  Object.defineProperty(w, 'garageX', { get: () => World.LANDMARKS.fixerGarage.x, configurable: true });
  Object.defineProperty(w, 'garageY', { get: () => World.LANDMARKS.fixerGarage.y, configurable: true });
  w.playerCar = () => game.player.car;
  Object.defineProperty(w, 'cash', {
    get: () => game.player.cash, set: (v) => { game.player.cash = v; }, configurable: true,
  });
  w.addCash = (n) => { game.player.cash += n; };
  w.setPaused = (b) => {
    if (b) { game.state = 'paused'; }
    else if (game.state === 'paused') { game.state = 'playing'; }
  };
}

// Link the player module's state object as game.player (single source
// of truth), carrying over cash + weapons from main's player state.
function linkPlayerState() {
  if (!gPlayer || !gPlayer.state) return;
  const st = gPlayer.state;
  const cur = game.player;
  if (cur && cur !== st) {
    if (typeof st.cash === 'number' && cur.cash) st.cash = cur.cash;
    st.weapons = cur.weapons || st.weapons;
    st.currentWeapon = cur.currentWeapon || st.currentWeapon || 'pistol';
    st.weaponName = cur.weaponName || st.weaponName;
    st.ammo = cur.ammo === undefined ? st.ammo : cur.ammo;
    st.fireCooldown = cur.fireCooldown || 0;
    st.color = cur.color || st.color;
    st.maxHealth = cur.maxHealth || st.maxHealth || 100;
    if (typeof st.health !== 'number') st.health = cur.health || 100;
    // Position + vitals come from main's player state (hideout start,
    // load-slot restores, new-game resets) — the module starts at its
    // own default and must adopt main's spawn point.
    st.x = cur.x;
    st.y = cur.y;
    st.angle = cur.angle || 0;
    st.speed = 0;
    st.health = cur.health || 100;
    st.onFoot = cur.onFoot !== false;
    st.car = cur.car || null;
  }
  game.player = st;
}

// Re-expose the wired instances + autopilot hook on the playtest
// handle. Called from wireGModules() and again in boot(), after the
// window.__crescentBay literal is assigned (which would wipe them).
function exposeWiring() {
  if (typeof window === 'undefined') return;
  window.__crescentBay = window.__crescentBay || {};
  if (gAutopilot) {
    window.__crescentBay.autopilot = (gm, dt, inp) => {
      let drove = false;
      try {
        const out = typeof gAutopilot.update === 'function' ? gAutopilot.update(dt) : null;
        const inputObj = out || gAutopilot.input;
        if (gAutopilot.active && inputObj) {
          drove = !!(inputObj.up || inputObj.down || inputObj.left || inputObj.right ||
            inputObj.interact || inputObj.shoot || inputObj.sprint);
        }
      } catch (err) {
        console.warn('[autopilot]', err && err.message);
      }
      return drove;
    };
  }
  window.__crescentBay._modules = {
    audio: gAudio, traffic: gTraffic, pedestrians: gPeds, combat: gCombatWrapped || gCombat,
    player: gPlayer, autopilot: gAutopilot, hud: gHud, helicopter: gHeli,
    garage: gGarage, weapons: gWeapons, save: gSave,
    policeDept: gPoliceDept, wanted: gWanted, context: gctx,
  };
  window.__crescentBay._wired = {
    audio: !!gAudio, traffic: !!gTraffic, pedestrians: !!gPeds, combat: !!gCombat,
    player: !!gPlayer, autopilot: !!gAutopilot, hud: !!gHud, helicopter: !!gHeli,
    garage: !!gGarage, weapons: !!gWeapons, save: !!gSave,
    policeDept: !!gPoliceDept, wanted: !!gWanted,
  };
}

function wireGModules() {
  if (gctx) return;
  gctx = buildGContext();
  attachWorldHelpers();
  gAudio = instantiate(AudioMod, ['createAudio'], gctx);
  gTraffic = instantiate(Traffic, ['createTraffic'], gctx);
  gPeds = instantiate(Pedestrians, ['createPedestrians'], gctx);
  gCombat = instantiate(Combat, ['createCombat'], gctx);
  gCombatWrapped = makeCombatWrapper(gCombat);
  gPlayer = instantiate(PlayerMod, ['createPlayer'], gctx);
  gAutopilot = instantiate(Autopilot, ['createAutopilot'], gctx);
  gHud = instantiate(Hud, ['createHud'], gctx);
  gHeli = instantiate(Helicopter, ['createHelicopter'], gctx);
  gGarage = instantiate(Garage, ['createGarage'], gctx);
  gWeapons = instantiate(Weapons, ['createWeapons']);
  gSave = instantiate(SaveMod, ['createSaveSystem']);
  gPoliceDept = instantiate(Police, ['createPoliceDepartment'], gctx);
  try {
    gWanted = typeof Police.createWantedState === 'function' ? Police.createWantedState() : null;
  } catch (err) { gWanted = null; }
  try {
    if (typeof Missions.attachMissionContext === 'function') Missions.attachMissionContext(gctx);
  } catch (err) { console.warn('[wiring] attachMissionContext failed:', err && err.message); }
  // The player module owns movement from here on.
  linkPlayerState();
  // Seed the combat module's weapon crates (its own list, separate
  // from main's seeded pickups).
  try { if (gCombat && typeof gCombat.seedWorldCrates === 'function') gCombat.seedWorldCrates(); } catch (err) { /* crates stay main-seeded */ }
  // Weapon-crate helper from weapons.js takes the spot list itself.
  try {
    if (typeof Weapons.createWeaponCrates === 'function') Weapons.createWeaponCrates(gctx.spots);
  } catch (err) { /* main-seeded crates cover it */ }
  // Expose the wired instances for the playtest harness + probes.
  exposeWiring();
}

// Normalize one traffic-module car so main's driving/render code can
// read it (additive only — never replaces the module's own fields).
function normalizeTrafficCar(car) {
  if (!car) return car;
  if (car.w !== undefined && car.length === undefined) car.length = car.w;
  if (car.h !== undefined && car.width === undefined) car.width = car.h;
  if (car.topSpeed === undefined && car.type && typeof car.type === 'object' && car.type.topSpeed) car.topSpeed = car.type.topSpeed;
  if (car.cruise === undefined) car.cruise = car.topSpeed || 200;
  if (car.kind === undefined && typeof car.type === 'string') car.kind = car.type;
  return car;
}

function normalizePed(ped) {
  if (!ped) return ped;
  if (ped.angle === undefined) {
    ped.angle = ped.axis === 'v' ? (ped.dir >= 0 ? Math.PI / 2 : -Math.PI / 2) : (ped.dir >= 0 ? 0 : Math.PI);
  }
  if (ped.color === undefined) ped.color = '#e8e0d0';
  // The module owns the flee state — mirror it every frame (it flips
  // back to walk on its own, so a one-time copy would go stale).
  ped.fleeing = ped.state === 'flee';
  return ped;
}

// Sync the module-owned lists back into game.* (the renderer's source
// of truth) once per frame. Same object references — no copies.
function syncModuleState() {
  if (gTraffic) {
    try {
      const moving = typeof gTraffic.cars === 'function' ? gTraffic.cars() : [];
      const parked = typeof gTraffic.parkedCars === 'function' ? gTraffic.parkedCars() : [];
      game.cars.length = 0;
      for (const c of moving) game.cars.push(normalizeTrafficCar(c));
      for (const c of parked) game.cars.push(normalizeTrafficCar(c));
    } catch (err) { /* keep last good game.cars */ }
  }
  if (gPeds) {
    try {
      const list = typeof gPeds.list === 'function' ? gPeds.list() : [];
      game.pedestrians.length = 0;
      for (const p of list) game.pedestrians.push(normalizePed(p));
    } catch (err) { /* keep last good pedestrians */ }
  }
  if (gHeli && gHeli.heli) {
    game.helicopter = gHeli.heli;
    const h = gHeli.heli;
    h.spotlightX = h.spotOn ? game.player.x : h.x;
    h.spotlightY = h.spotOn ? game.player.y : h.y;
    h.smoking = (h.smoke || 0) > 0;
    h.rotor = h.rotorAngle || 0;
    h.shadowX = h.x;
    h.shadowY = h.y;
  }
  if (gCombat) {
    try {
      const cs = typeof gCombat.state === 'function' ? gCombat.state() : null;
      if (cs) {
        const weapons = {};
        for (const id of WEAPON_ORDER) {
          weapons[id] = {
            owned: !!(cs.owned && cs.owned[id]),
            ammo: cs.ammo ? (cs.ammo[id] || 0) : 0,
          };
        }
        game.player.weapons = weapons;
        game.player.currentWeapon = cs.current || game.player.currentWeapon;
        refreshWeaponHud();
      }
      // Merge combat crates/ammo into game.pickups (deduped by crate).
      const crates = typeof gCombat.crates === 'function' ? gCombat.crates() : [];
      for (const c of crates) {
        if (!c || c.taken || gSyncedCrates.has(c)) continue;
        gSyncedCrates.add(c);
        game.pickups.push({ x: c.x, y: c.y, kind: 'crate', weapon: c.weapon, label: c.label || c.weapon, _crate: c });
      }
      const ammo = typeof gCombat.ammoPickups === 'function' ? gCombat.ammoPickups() : [];
      for (const a of ammo) {
        if (!a || a.taken || gSyncedCrates.has(a)) continue;
        gSyncedCrates.add(a);
        game.pickups.push({ x: a.x, y: a.y, kind: 'ammo', _crate: a });
      }
    } catch (err) { /* HUD/ammo sync is best-effort */ }
  }
  if (gAudio) {
    try {
      const levels = typeof gAudio.equalizerLevel === 'function' ? gAudio.equalizerLevel() : null;
      if (levels) game.radio.levels = levels;
      const name = typeof gAudio.stationName === 'function' ? gAudio.stationName() : null;
      if (name) game.radio.name = name;
    } catch (err) { /* radio HUD is best-effort */ }
  }
}

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
  // Prefer the wired save module (v4 keys/payloads) when it exists.
  if (gSave && typeof gSave.readSlot === 'function') {
    try {
      const stored = gSave.readSlot(slot - 1);
      return stored || null;
    } catch (err) { /* fall through to the local fallback */ }
  }
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
  if (gSave && typeof gSave.saveToSlot === 'function' && typeof gSave.buildPayload === 'function') {
    try {
      const payload = gSave.buildPayload(game);
      gSave.saveToSlot(slot - 1, payload);
      refreshSlotList();
      return payload;
    } catch (err) { /* fall through to the local fallback */ }
  }
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
    const button = document.createElement('button');
    button.className = 'save-slot';
    button.dataset.slot = String(slot);
    if (gSave && typeof gSave.slotSummary === 'function') {
      try {
        const summary = gSave.slotSummary(slot - 1);
        button.textContent = summary && summary.label
          ? 'Slot ' + slot + ' — ' + summary.label
          : 'Slot ' + slot + ' — Empty';
      } catch (err) {
        button.textContent = 'Slot ' + slot + ' — Empty';
      }
    } else {
      const data = readSlot(slot);
      if (!data) {
        button.textContent = 'Slot ' + slot + ' — Empty';
      } else if (data.corrupt) {
        button.textContent = 'Slot ' + slot + ' — Corrupt (click to overwrite)';
      } else {
        const date = data.date ? new Date(data.date).toLocaleDateString() : '';
        button.textContent = 'Slot ' + slot + ' — ' + (data.missionName || data.mission) +
          ' · $' + (data.cash || 0) + ' · ' + date;
      }
    }
    button.addEventListener('click', () => {
      game.activeSlot = slot;
      loadSlot(slot);
    });
    list.appendChild(button);
  }
}

export function loadSlot(slot) {
  if (gSave && typeof gSave.loadSlot === 'function') {
    try {
      const payload = gSave.loadSlot(slot - 1);
      if (!payload) {
        startNewGame();
        return;
      }
      applySavePayload(payload);
      hideOverlays();
      game.state = 'playing';
      return;
    } catch (err) { /* fall through to the local fallback */ }
  }
  const data = readSlot(slot);
  if (!data || data.corrupt) {
    startNewGame();
    return;
  }
  applySavePayload(data);
  hideOverlays();
  game.state = 'playing';
}

// Apply a save payload in either shape: the save module's v4 payload
// ({player:{...}, cash, highestMission, ...}) or main's v1 slot shape.
function applySavePayload(data) {
  if (!data) return;
  const p = data.player || data;
  if (typeof p.cash === 'number') game.player.cash = p.cash;
  else if (typeof data.cash === 'number') game.player.cash = data.cash;
  if (typeof p.health === 'number') game.player.health = p.health;
  if (typeof p.x === 'number') game.player.x = p.x;
  if (typeof p.y === 'number') game.player.y = p.y;
  const missionId = data.mission || data.missionId ||
    (typeof data.highestMission === 'number' && MISSION_LIST[data.highestMission]
      ? MISSION_LIST[data.highestMission].id : null);
  if (missionId) {
    game.missionId = missionId;
    const def = MISSION_LIST.find((m) => m.id === missionId);
    game.missionName = data.missionName || (def && def.name) || null;
  }
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
  // Prefer the wired audio module (its station list matches the spec).
  if (gAudio && typeof gAudio.nextStation === 'function') {
    try {
      gAudio.nextStation();
      const name = typeof gAudio.stationName === 'function' ? gAudio.stationName() : null;
      if (name) {
        game.radio.name = name;
        const idx = RADIO_STATIONS.findIndex((s) => s.name === name);
        if (idx >= 0) game.radio.index = idx;
      } else {
        game.radio.index = (game.radio.index + 1) % RADIO_STATIONS.length;
        game.radio.name = RADIO_STATIONS[game.radio.index].name;
      }
      setText('radio-station', '♪ ' + game.radio.name);
      if (typeof window !== 'undefined') {
        window.__crescentBay = window.__crescentBay || {};
        window.__crescentBay.radioStation = game.radio.name;
      }
      return;
    } catch (err) { /* fall through to the module hook / fallback */ }
  }
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
  // The wired audio module drives the radio in its own update(); no
  // timer is needed when it exists.
  if (gAudio) return;
  if (hasHook(Radio, ['startRadio', 'createRadio', 'initRadio'])) {
    callHook(Radio, ['startRadio', 'createRadio', 'initRadio'], game);
    return;
  }
  ensureAudio();
  if (radioTimer) return;
  radioTimer = setInterval(radioTick, 140);
}

// Small sound effects through the wired audio module when it has
// one, else a plain WebAudio blip here.
function sfx(kind) {
  if (gAudio && typeof gAudio.sfx === 'function') {
    try {
      gAudio.sfx(kind);
      return;
    } catch (err) { /* fall through to the blip */ }
  }
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
  if (gCombat && typeof gCombat.setWeapon === 'function') {
    try { gCombat.setWeapon(id); } catch (err) { /* keep main's selection */ }
  }
  if (gWeapons && typeof gWeapons.select === 'function') {
    try { gWeapons.select(id); } catch (err) { /* keep main's selection */ }
  }
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
  if (gCombat && typeof gCombat.giveWeapon === 'function') {
    try { gCombat.giveWeapon(id, ammo === undefined ? def.startAmmo : ammo); } catch (err) { /* fall through */ }
  }
  if (!game.player.weapons[id]) game.player.weapons[id] = { owned: true, ammo: 0 };
  game.player.weapons[id].owned = true;
  game.player.weapons[id].ammo += ammo === undefined ? def.startAmmo : ammo;
  refreshWeaponHud();
}

function shootWeapon(angle) {
  // The combat module owns firing (ammo, cooldown, bullets, hits).
  if (gCombat && typeof gCombat.fire === 'function') {
    try {
      fireCombat(game.player.x, game.player.y, angle, game.enemies);
      sfx('shoot');
      // Gunfire scares nearby pedestrians.
      if (gPeds && typeof gPeds.scare === 'function') {
        try { gPeds.scare(game.player.x, game.player.y, 300); } catch (err) { /* scare is best-effort */ }
      } else {
        for (const ped of game.pedestrians) {
          const d = Math.hypot(ped.x - game.player.x, ped.y - game.player.y);
          if (d < 300) ped.fleeing = true;
        }
      }
      return;
    } catch (err) { /* fall through to the local fallback */ }
  }
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
  // under it. The helicopter module reports this directly when wired.
  let spotlightOn = false;
  if (gHeli && typeof gHeli.blocksHeatDecay === 'function') {
    try {
      spotlightOn = !!gHeli.blocksHeatDecay();
    } catch (err) {
      spotlightOn = false;
    }
  }
  if (!spotlightOn) {
    spotlightOn = game.helicopter && game.helicopter.spotlightX !== undefined &&
      Math.hypot(game.helicopter.spotlightX - game.player.x, game.helicopter.spotlightY - game.player.y) < 120;
  }
  let policeNear = false;
  for (const cop of game.police) {
    if (Math.hypot(cop.x - game.player.x, cop.y - game.player.y) < HEAT_DECAY_RADIUS) {
      policeNear = true;
      break;
    }
  }
  // The Spray Shop clears heat fast while Rook sits inside it — this
  // is the escape hatch, so it runs even with police near or the
  // helicopter spotlight overhead (those only block hiding decay).
  const shop = World.LANDMARKS.sprayShop;
  if (Math.hypot(game.player.x - shop.x, game.player.y - shop.y) < SPRAY_SHOP_RADIUS) {
    addHeat(-SPRAY_SHOP_DRAIN * dt);
  }
  if (policeNear || spotlightOn) {
    game.hideTimer = 0;
    return;
  }
  game.hideTimer += dt;
  if (game.hideTimer >= HEAT_DECAY_DELAY) {
    addHeat(-14 * dt);
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
      if (p._crate) {
        try { p._crate.taken = true; } catch (err) { /* crate flag is best-effort */ }
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
  // Act 2 missions (m9–m12) start through the act2 module; m1–m8 run
  // on main's mission list + the missions module's stage data.
  if (isAct2Mission(id) && typeof Act2.startAct2Mission === 'function') {
    try {
      const started = Act2.startAct2Mission(game, id);
      if (started === false) return false;
    } catch (err) { /* act2 start is best-effort; main's flow continues */ }
  }
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
  startArcFor(id);
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
  let nextId = null;
  if (def) {
    game.player.cash += def.reward;
    const nextIndex = MISSION_LIST.findIndex((m) => m.id === def.id) + 1;
    nextId = nextIndex < MISSION_LIST.length ? MISSION_LIST[nextIndex].id : null;
    game.missionId = nextId;
  }
  game.missionName = null;
  game.missionTimer = null;
  game.objective = null;
  arcStages = null;
  arcStageIndex = 0;
  writeSlot(game.activeSlot); // autosave after each mission
  sfx('pickup');
  // Linear arc: the next job is offered right away (its dialog opens
  // and the autopilot accepts it, so the arc keeps flowing).
  if (nextId) startMission(nextId);
}

function isAct2Mission(id) {
  return id === 'm9' || id === 'm10' || id === 'm11' || id === 'm12';
}

// --- Arc driver (finisher): turns mission stage data into autopilot
// objectives and advances stages on position / ram / kill / escape
// conditions. The missions module holds the stage tables (m1–m8) and
// the act2 module the m9–m12 flow; main drives both from here. ---

let arcStages = null;
let arcStageIndex = 0;
let arcRamHits = 0;
let arcLastRamAt = -10;
let arcContactTime = 0; // seconds the player car has sat touching the courier
let arcChaseMode = 'goto'; // chase stage navigation: 'goto' (far) then 'chase' (near)

// The traffic module never turns its cars: they drive straight along
// their spawn direction and leave the 3200x3200 map within ~20s
// (verified in Node: 0/14 on-map after 20s, cars at y=-40000). The
// module respawns to its target count, so removing off-map cars keeps
// the city populated — and keeps a chasable courier on the map.
function pruneOffMapTraffic() {
  if (!gTraffic || typeof gTraffic.remove !== 'function') return;
  let cars = [];
  try { cars = gTraffic.cars() || []; } catch (err) { return; }
  for (const car of [...cars]) {
    if (!car || car === game.player.car) continue;
    if (car.x < -100 || car.x > 3300 || car.y < -100 || car.y > 3300) {
      try { gTraffic.remove(car); } catch (err) { /* best-effort */ }
    }
  }
}

// A courier is only chasable while it is on the map and reachable:
// a traffic car can drive off the north edge (one courier reached
// y=-94194 in 240s) and then no autopilot mode can ever catch it.
function isCourierValid(courier) {
  if (!courier || !isFinite(courier.x) || !isFinite(courier.y)) return false;
  if (courier.x < -100 || courier.x > 3300 || courier.y < -100 || courier.y > 3300) return false;
  return true;
}

// Pick a courier for a chase stage: a DRIVEN traffic car. The old
// fallback (nearestCar) could return a PARKED car sitting off-road
// inside a block — the autopilot then chases a target no road reaches.
// Widen the radius: a driven car 2000px away beats a parked one 200px
// away. Returns null when no driven car exists at all.
function pickDrivenCourier(maxDist) {
  let courier = null;
  try {
    if (gTraffic && typeof gTraffic.nearestDriven === 'function') {
      courier = gTraffic.nearestDriven(game.player.x, game.player.y, maxDist);
    }
  } catch (err) { courier = null; }
  if (courier && !isCourierValid(courier)) courier = null;
  if (!courier) {
    let best = null;
    let bestDist = maxDist;
    for (const car of game.cars) {
      if (!car || !car.driver) continue;
      if (!isCourierValid(car)) continue;
      const d = Math.hypot(car.x - game.player.x, car.y - game.player.y);
      if (d < bestDist) { bestDist = d; best = car; }
    }
    courier = best;
  }
  return courier;
}

function setArcObjective(obj) {
  if (!obj) return;
  game.objective = { text: obj.text || obj.label || 'Objective', x: obj.x, y: obj.y };
  if (gAutopilot && typeof gAutopilot.setObjective === 'function') {
    try {
      gAutopilot.setObjective({ type: obj.type || 'goto', x: obj.x, y: obj.y });
    } catch (err) { /* autopilot objective is best-effort */ }
  }
  if (gHud && typeof gHud.setObjective === 'function') {
    try { gHud.setObjective(game.objective); } catch (err) { /* HUD objective is best-effort */ }
  }
}

function startArcFor(id) {
  arcRamHits = 0;
  arcLastRamAt = -10;
  arcContactTime = 0;
  arcChaseMode = 'goto';
  gCourierCar = null;
  if (isAct2Mission(id)) {
    arcStages = null;
    arcStageIndex = 0;
    try {
      const t = typeof Act2.act2CurrentTarget === 'function' ? Act2.act2CurrentTarget(game) : null;
      if (t) setArcObjective({ type: 'goto', x: t.x, y: t.y, text: t.label || '' });
    } catch (err) { /* act2 target is best-effort */ }
    return;
  }
  let stages = null;
  try {
    const def = typeof Missions.missionById === 'function' ? Missions.missionById(id) : null;
    stages = def && def.stages ? def.stages : null;
  } catch (err) { stages = null; }
  arcStages = stages;
  arcStageIndex = 0;
  if (stages && stages.length) startArcStage();
}

function startArcStage() {
  const stage = arcStages && arcStages[arcStageIndex];
  if (!stage) {
    completeMission();
    return;
  }
  if (stage.kind === 'chase') {
    const courier = pickDrivenCourier(800) || pickDrivenCourier(4000);
    if (courier) {
      gCourierCar = courier;
      courier.cruise = 220;
      courier.courier = true;
    }
    arcRamHits = 0;
    arcContactTime = 0;
    arcChaseMode = 'goto';
    setArcObjective({ type: 'chase', x: stage.x, y: stage.y, text: stage.label });
    return;
  }
  if (stage.kind === 'shootout') {
    const count = stage.enemies || 3;
    game.enemies.length = 0;
    for (let i = 0; i < count; i++) {
      game.enemies.push({
        x: stage.x + 120 + i * 60, y: stage.y - 40 + i * 40,
        angle: Math.PI, hp: 36, maxHp: 36, color: '#d8d8d8',
      });
    }
    setArcObjective({ type: 'shootout', x: stage.x, y: stage.y, text: stage.label });
    return;
  }
  if (stage.kind === 'escape') {
    setArcObjective({
      type: 'escape',
      x: World.LANDMARKS.sprayShop.x, y: World.LANDMARKS.sprayShop.y,
      text: stage.label,
    });
    return;
  }
  setArcObjective({ type: 'goto', x: stage.x, y: stage.y, text: stage.label });
}

function advanceArcStage() {
  arcStageIndex += 1;
  if (!arcStages || arcStageIndex >= arcStages.length) {
    completeMission();
    return;
  }
  startArcStage();
}

function updateArc(dt) {
  void dt;
  if (!game.missionId || game.state !== 'playing') return;
  if (isAct2Mission(game.missionId)) {
    try {
      if (typeof Act2.updateAct2Mission === 'function') Act2.updateAct2Mission(game, dt);
    } catch (err) { console.warn('[arc] updateAct2Mission:', err && err.message); }
    let done = false;
    try {
      const status = typeof Act2.act2MissionStatus === 'function' ? Act2.act2MissionStatus(game) : null;
      if (status && (status.complete === true || status.status === 'complete' || status.status === 'done')) done = true;
    } catch (err) { /* status check is best-effort */ }
    if (done) {
      completeMission();
      return;
    }
    try {
      const t = typeof Act2.act2CurrentTarget === 'function' ? Act2.act2CurrentTarget(game) : null;
      if (t) {
        if (!game.objective || Math.hypot(game.objective.x - t.x, game.objective.y - t.y) > 50) {
          setArcObjective({ type: 'goto', x: t.x, y: t.y, text: t.label || '' });
        }
        const near = Math.hypot(game.player.x - t.x, game.player.y - t.y) < 100;
        const label = String(t.label || '').toLowerCase();
        if (near && game.missionId === 'm9') completeMission();
        else if (near && game.missionId === 'm12' && label.includes('plane')) completeMission();
        else if (near && game.missionId === 'm10' && game.enemies.length === 0) completeMission();
      }
    } catch (err) { /* target tracking is best-effort */ }
    return;
  }
  const stages = arcStages;
  if (!stages || !stages.length) return;
  const stage = stages[arcStageIndex];
  if (!stage) {
    completeMission();
    return;
  }
  if (stage.kind === 'chase') {
    // Self-healing: if the stage started with no driven car nearby,
    // or the courier drove off the map / too far to ever catch, pick
    // a fresh one — traffic respawns, and a chase with no courier
    // parks the autopilot on a phantom point.
    if (!gCourierCar || !isCourierValid(gCourierCar)) {
      const courier = pickDrivenCourier(4000);
      if (courier) {
        gCourierCar = courier;
        courier.cruise = 220;
        courier.courier = true;
        arcChaseMode = 'goto';
      } else {
        return; // nothing to chase yet; wait on the stage objective
      }
    }
    const car = game.player.car;
    const courier = gCourierCar;
    if (car && courier) {
      const d = Math.hypot(car.x - courier.x, car.y - courier.y);
      const speed = Math.abs(car.speed || 0);
      const hitsNeeded = stage.hitsNeeded || 4;
      const countHit = () => {
        arcLastRamAt = game.time;
        arcRamHits += 1;
        arcContactTime = 0;
        courier.cruise = Math.max(120, (courier.cruise || 220) * 0.55);
        setArcObjective({ type: 'chase', x: courier.x, y: courier.y, text: stage.label + ' — hits ' + arcRamHits + '/' + hitsNeeded });
        if (arcRamHits >= hitsNeeded) advanceArcStage();
      };
      if (d < 70 && speed > 120 && game.time - arcLastRamAt > 1) {
        // Speed ram — the normal case.
        countHit();
      } else if (d < 110 && speed < 60) {
        // Contact ram: the cars are close but the player car cannot
        // build speed — the courier stopped moving (parked / stalled
        // after earlier rams) and the autopilot idles at "arrived"
        // on top of it, outputting no input. Sustained closeness
        // counts as a ram so the stage cannot deadlock.
        arcContactTime += dt;
        if (arcContactTime > 2 && game.time - arcLastRamAt > 1) countHit();
      } else {
        arcContactTime = 0;
      }
      // Navigation: the autopilot's chase steering drives straight at
      // the target with no road routing — across a block it wedges
      // between buildings and spins (m3 sat 240s at 1400px). So far
      // away, navigate with 'goto' (road-routed, purposeful); only
      // switch to 'chase' ramming once close, where a straight line
      // works. The lead point (150px beyond the courier) keeps the
      // autopilot driving THROUGH the courier instead of idling at
      // "arrived" on top of it.
      const label = stage.label + ' — hits ' + arcRamHits + '/' + hitsNeeded;
      const wantMode = d > 1500 ? 'goto' : 'chase';
      let tx, ty;
      if (wantMode === 'goto') {
        tx = courier.x; ty = courier.y;
      } else {
        const dx = courier.x - car.x, dy = courier.y - car.y;
        const dl = Math.hypot(dx, dy) || 1;
        tx = courier.x + (dx / dl) * 150;
        ty = courier.y + (dy / dl) * 150;
      }
      const modeChanged = wantMode !== arcChaseMode;
      arcChaseMode = wantMode;
      const moved = !game.objective || Math.hypot(game.objective.x - tx, game.objective.y - ty) > (wantMode === 'goto' ? 80 : 60);
      if (modeChanged || moved) {
        setArcObjective({ type: wantMode, x: tx, y: ty, text: label });
      }
    }
    return;
  }
  if (stage.kind === 'shootout') {
    if (game.enemies.length === 0) advanceArcStage();
    return;
  }
  if (stage.kind === 'escape') {
    if (game.stars === 0) advanceArcStage();
    return;
  }
  if (Math.hypot(game.player.x - stage.x, game.player.y - stage.y) < 100) {
    try { if (typeof Missions.consumePickup === 'function') Missions.consumePickup(stage); } catch (err) { /* consume is best-effort */ }
    advanceArcStage();
  }
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
  // Prefer the wired garage module (its own menu + purchase state).
  if (gGarage && typeof gGarage.openMenu === 'function') {
    try {
      gGarage.openMenu();
      game.garageOpen = true;
      game.state = 'paused';
      setText('garage-cash', 'Cash: $' + Math.floor(game.player.cash));
      return;
    } catch (err) { /* fall through to the local menu */ }
  }
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
  // Prefer the wired garage module (it checks cash + levels itself).
  if (gGarage && typeof gGarage.buy === 'function') {
    try {
      const ok = gGarage.buy(id);
      if (ok) {
        game.missionGaragePurchase = true;
        sfx('pickup');
        if (typeof Act2.act2OnGaragePurchase === 'function' && isAct2Mission(game.missionId)) {
          try { Act2.act2OnGaragePurchase(game, id); } catch (err) { /* act2 hook is best-effort */ }
        }
      }
      return !!ok;
    } catch (err) { /* fall through to the local purchase */ }
  }
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

export function buyCheapestUpgrade() {
  if (gGarage && typeof gGarage.buyCheapest === 'function') {
    try {
      const bought = gGarage.buyCheapest();
      if (bought) {
        game.missionGaragePurchase = true;
        sfx('pickup');
      }
      return !!bought;
    } catch (err) { /* fall through to the local cheapest */ }
  }
  const car = game.player.car;
  if (!car) return false;
  car.upgrades = car.upgrades || { engine: 0, armor: 0, tires: 0, brakes: 0 };
  let best = null;
  let bestPrice = Infinity;
  for (const up of GARAGE_UPGRADES) {
    const level = car.upgrades[up.id] || 0;
    if (level >= up.levels) continue;
    const price = up.prices[level];
    if (price < bestPrice && game.player.cash >= price) {
      best = up.id;
      bestPrice = price;
    }
  }
  if (!best) return false;
  return buyUpgrade(best);
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
  if (gGarage && typeof gGarage.closeMenu === 'function') {
    try { gGarage.closeMenu(); } catch (err) { /* fall through */ }
  }
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
  linkPlayerState();
  // Audio init must come from a user gesture — New Game is one.
  if (gAudio && typeof gAudio.init === 'function') {
    try { gAudio.init(); } catch (err) { /* audio init is best-effort */ }
  }
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

  // Dialog: only the accept key matters; the world waits. The
  // autopilot accepts too — its interact flag is the accept key when
  // it is active (the keyboard alone deadlocked the arc here).
  if (game.state === 'dialog') {
    const apInteract = gAutopilot && gAutopilot.active && gAutopilot.input && gAutopilot.input.interact;
    if (apInteract || input.actionPressed('interact')) acceptDialog();
    return;
  }
  // Pause / resume: checked before the playing gate, or Escape could
  // pause the game but never resume it.
  if (input.actionPressed('pause')) {
    togglePause();
    return;
  }
  if (game.state !== 'playing') return;

  // Radio / weapon keys.
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

  // Player movement — the player module owns it when wired (it reads
  // the autopilot input when the autopilot is active, else the keys),
  // so it must run even on frames the autopilot drove. Without the
  // module, manual driving is skipped on autopilot frames so the two
  // never fight over the same car.
  let playerHandled = false;
  if (gPlayer) {
    playerHandled = callInstance(gPlayer, ['update', 'updatePlayer', 'step', 'tick'], dt);
  }
  if (!playerHandled && !game.autopilotDrove) {
    if (game.player.onFoot) updatePlayerOnFoot(dt, input);
    else updatePlayerDriving(dt, input);
  }

  // Manual shooting (on foot, mouse held): the input module exposes
  // the mouse as mouseDown, not as a 'shoot' action, and the player
  // module only fires on autopilot input — so main fires on mouse
  // input. (Autopilot shooting stays with the player module.)
  if (game.player.onFoot && input && input.mouseDown && !game.autopilotDrove) {
    shootWeapon(input.aimAngle(game.player.x, game.player.y));
  }

  // Systems — the wired module instances first, main's fallbacks only
  // when a module is absent. (Police.updatePolice is NOT called: its
  // context shape is undetermined and it throws in probes; the
  // fallback below implements the same pursuit/arrest rules.)
  if (gTraffic) {
    callInstance(gTraffic, ['update', 'updateTraffic', 'step', 'tick'], dt);
  } else if (hasHook(Vehicles, ['updateVehicles', 'update', 'updateTraffic'])) {
    callHook(Vehicles, ['updateVehicles', 'update', 'updateTraffic'], game, dt);
  } else {
    updateTrafficFallback(dt);
  }
  pruneOffMapTraffic();
  if (gPeds) {
    callInstance(gPeds, ['update', 'updatePedestrians', 'step', 'tick'], dt);
  } else {
    updatePedestriansFallback(dt);
  }
  updatePoliceFallback(dt);
  if (gHeli) {
    callInstance(gHeli, ['update', 'updateHelicopter', 'step', 'tick'], dt);
  } else if (hasHook(Helicopter, ['updateHelicopter', 'update'])) {
    callHook(Helicopter, ['updateHelicopter', 'update'], game, dt);
  } else {
    updateHelicopterFallback(dt);
  }
  if (gCombat) {
    callInstance(gCombat, ['update', 'updateCombat', 'step', 'tick'], dt);
  } else if (hasHook(Weapons, ['updateWeapons', 'update'])) {
    callHook(Weapons, ['updateWeapons', 'update'], game, dt);
  }
  if (gWeapons) callInstance(gWeapons, ['update'], dt);
  if (gAudio) callInstance(gAudio, ['update'], dt);
  if (game.missionId) updateArc(dt);
  updateMissionFallback(dt);
  if (!gCombat) updateBullets(dt);
  updatePickups(dt);
  updateHeat(dt);
  syncModuleState();
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
  // Module-owned visuals the renderer does not draw: combat bullets
  // live inside the combat module, so only its draw shows them.
  if (gCombat && renderer && renderer.canvas) {
    try {
      const ctx = renderer.canvas.getContext('2d');
      if (ctx) callInstance(gCombat, ['draw'], ctx, game);
    } catch (err) { /* module draw is best-effort */ }
  }
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
  wireGModules();
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
    cycleWeapon,
    giveWeapon,
    writeSlot,
    loadSlot,
    startNewGame,
    endGame,
    openGarageMenu,
    closeGarageMenu,
    buyUpgrade,
    buyCheapestUpgrade,
    shots: Shots.createShotHandle(),
    get radioStation() { return game.radio.name; },
    set radioStation(v) { game.radio.name = v; },
    autopilot: null, // set by the autopilot module / playtest harness
  };

  // Re-apply the wiring exposure (the literal above replaced the
  // object that wireGModules() had annotated).
  exposeWiring();

  showOverlay('title-screen');
  updateCamera(0);
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

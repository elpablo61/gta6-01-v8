// Crescent Bay — main loop and wiring. Written fresh in this session
// from the prose spec (v4 spec sections 1-5 and 9, the builder brief,
// the v1/v2 rebuild notes). No earlier game file was read or copied:
// every line below is my own assembly of the fresh modules' published
// interfaces plus the spec's contracts for the older modules.
//
// What this file does: it builds one shared game object, constructs
// every subsystem against it, runs the frame loop (update then render,
// every frame), routes input, owns the title / pause / game-over DOM
// overlays, owns the single mission-start path (every mission change,
// including handoffs between missions, goes through startMissionById),
// and publishes the plain-data debug snapshot the playtest tools read.
//
// The three ordering rules the spec's lesson sections insist on:
//   1. The pause toggle is checked before any state early-exit, so a
//      paused game can always be unpaused.
//   2. The autopilot runs before the dialog branch, so it can press E
//      to accept a mission offer.
//   3. The player update runs on every playing frame, and manual
//      driving is skipped on frames the autopilot drove the car.

import { createWorld, WORLD_SIZE, LANDMARKS, PLAYER_SPAWN } from './world.js';
import { WORLD_SEED } from './random.js';
import { createInput } from './input.js';
import { createRenderer } from './render.js';
import {
  createPlayer,
  updatePlayer,
  addHeat,
  computeWantedStars,
  tryEnterCar,
  exitCar,
} from './player.js';
import {
  updateTraffic,
  createCar,
  driveCarToward,
  followMovingTarget,
  effectiveTopSpeed,
  nearestRoadPoint,
  nearestJunction,
  isOnRoad,
} from './traffic.js';
import { createPedestrians } from './pedestrians.js';
import { createCombat } from './combat.js';
import { createWeaponSystem } from './weapons.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createAutopilot } from './autopilot.js';
import { createFixerGarage } from './garage.js';
import { createPoliceHelicopter } from './helicopter.js';
import { createLivingCity } from './living-city.js';
import { createRadio } from './radio.js';
import { createSaveSlots } from './save.js';
import { applyShotSetup, getShotPose } from './shots.js';

// Older modules, wired only through their spec contracts and probed at
// runtime (namespace import + feature detection, never a guessed named
// import): missions offers MISSION_ARC m1-m12 with startMission and a
// dialog offer; police owns wanted heat, pursuit, roadblocks and the
// Spray Shop perimeter; act2 extends the arc with m9-m12; vehicles
// owns the radius-steering driving core; config holds the city
// constants. Each adapter below falls back to this file's own small
// spec-driven implementation when a module offers no usable handle, so
// a missing export can never freeze the game.
import * as MissionsMod from './missions.js';
import * as PoliceMod from './police.js';
import * as Act2Mod from './act2.js';
import * as VehiclesMod from './vehicles.js';
import * as ConfigMod from './config.js';

export const GAME_TITLE = (typeof ConfigMod.GAME_TITLE === 'string' && ConfigMod.GAME_TITLE)
  || 'Crescent Bay';
export const WORLD_SEED_USED = (typeof ConfigMod.WORLD_SEED === 'number')
  ? ConfigMod.WORLD_SEED
  : WORLD_SEED;
export const FRAME_DT = 1 / 60;
export const MAX_FRAME_DT = 0.05;
export const MISSION_OFFER_GRACE_SEC = 3;
export const FIRST_MISSION_GRACE_SEC = 4;
export const DIALOG_COOLDOWN_SEC = 10;
export const RESPAWN_CASH_LOSS = 0.1;
export const MISSION_REACH_RADIUS = 70;
export const RAM_HIT_RADIUS = 70;
export const RAM_HIT_SPEED = 120;
export const RAM_HIT_COOLDOWN = 1.0;
export const ESCAPE_DONE_HEAT = 0.5;

// The mission arc, straight from prose spec section 2. Each entry is
// the fallback plan the main loop uses when the missions module does
// not publish its own target for a stage: a list of stages, each stage
// a kind (goto / chase / shootout / collect / escape / garage) plus
// the landmark it points at. The missions module's own arc (when it
// publishes one) wins over this table; the table only ever fills gaps.
export const MISSION_FALLBACK_PLAN = {
  m1: {
    name: 'First Job', fixer: 'Mara', reward: 400, limit: 300,
    hook: 'Mara: A package is waiting at the market. Bring it downtown and the money is yours.',
    stages: [{ kind: 'goto', landmark: 'market' }, { kind: 'goto', landmark: 'downtown' }],
  },
  m2: {
    name: 'Tail Chase', fixer: 'Mara', reward: 700, limit: 300,
    hook: 'Mara: A courier is carrying something that belongs to us. Ram his car until he gives up.',
    stages: [{ kind: 'chase' }],
  },
  m3: {
    name: 'Hot Wheels', fixer: 'Dex', reward: 900, limit: 240,
    hook: 'Dex: Three checkpoints, one clock. Club, marina, airport — be quick about it.',
    stages: [
      { kind: 'goto', landmark: 'club' },
      { kind: 'goto', landmark: 'marina' },
      { kind: 'goto', landmark: 'airport' },
    ],
  },
  m4: {
    name: 'Dockside', fixer: 'Mara', reward: 1100, limit: 360,
    hook: 'Mara: A crate is waiting at the marina. Bring it to the hideout — and watch the docks.',
    stages: [{ kind: 'goto', landmark: 'marina' }, { kind: 'goto', landmark: 'hideout' }],
  },
  m5: {
    name: 'Midnight Run', fixer: 'Dex', reward: 1400, limit: 300, night: true,
    hook: 'Dex: A night run. Pick up at the club, drop at the docks. Keep the headlights on.',
    stages: [{ kind: 'goto', landmark: 'club' }, { kind: 'goto', landmark: 'docks' }],
  },
  m6: {
    name: 'Collector', fixer: 'Mara', reward: 1800, limit: 420,
    hook: 'Mara: Five money drops are scattered around the city. Collect them all, then come home.',
    stages: [{ kind: 'collect' }, { kind: 'goto', landmark: 'hideout' }],
  },
  m7: {
    name: 'Highway Heat', fixer: 'Dex', reward: 4600, limit: 420, coverHeat: 58,
    hook: 'Dex: Drive to the airport — and when the heat comes, lose it. All of it.',
    stages: [{ kind: 'goto', landmark: 'airport' }, { kind: 'escape' }],
  },
  m8: {
    name: 'Crescent Job', fixer: 'Mara', reward: 6200, limit: 600,
    hook: 'Mara: The bank crew is inside. Clear the room, then get out clean.',
    stages: [{ kind: 'shootout', enemies: 3 }, { kind: 'escape' }],
  },
  m9: {
    name: 'Sky Watch', fixer: 'Dex', reward: 2000, limit: 420, coverHeat: 58, heli: true,
    hook: 'Dex: The helicopter is up and it is not leaving. Reach the hideout anyway.',
    stages: [{ kind: 'goto', landmark: 'hideout' }],
  },
  m10: {
    name: 'Full Auto', fixer: 'Mara', reward: 2500, limit: 420,
    hook: 'Mara: Dockside shootout, five of them. There are weapon crates in the arena — use them.',
    stages: [{ kind: 'shootout', enemies: 5 }, { kind: 'goto', landmark: 'hideout' }],
  },
  m11: {
    name: 'Tune-Up', fixer: 'Dex', reward: 3000, limit: 420,
    hook: 'Dex: Take the car to my garage, buy something for it, then run three checkpoints in it.',
    stages: [
      { kind: 'garage' },
      { kind: 'goto', landmark: 'club' },
      { kind: 'goto', landmark: 'marina' },
      { kind: 'goto', landmark: 'airport' },
    ],
  },
  m12: {
    name: 'Bay Finale', fixer: 'Mara', reward: 8000, limit: 600, coverHeat: 74, heli: true,
    hook: 'Mara: The bank, the loot, the airport, the plane. One run, everything on the line.',
    stages: [
      { kind: 'shootout', enemies: 4 },
      { kind: 'goto', landmark: 'bank' },
      { kind: 'goto', landmark: 'airport' },
      { kind: 'goto', landmark: 'plane' },
    ],
  },
};

export const MISSION_ORDER = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'];

export const COLLECT_DROP_SPOTS = ['market', 'downtown', 'club', 'marina', 'airport'];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function landmarkPoint(name) {
  const marks = (game && game.world && game.world.landmarks) || LANDMARKS;
  const m = marks && marks[name];
  if (m && typeof m.x === 'number') return { x: m.x, y: m.y, label: m.label || name, static: true };
  return null;
}

function pickFn(ns, names) {
  if (!ns) return null;
  for (const name of names) {
    if (typeof ns[name] === 'function') return ns[name];
  }
  return null;
}

function pickValue(ns, names) {
  if (!ns) return undefined;
  for (const name of names) {
    if (ns[name] !== undefined) return ns[name];
  }
  return undefined;
}

// --- URL flags ---------------------------------------------------------------
// ?autopilot=<m1..m12|arc> starts the in-game autopilot for that mission
// or the whole arc. ?shot=<id>&seed=7 plays a screenshot pose.
function readQuery() {
  const out = { autopilot: null, shot: null, seed: 7 };
  try {
    const params = new URLSearchParams(window.location.search);
    out.autopilot = params.get('autopilot');
    out.shot = params.get('shot');
    const seed = Number(params.get('seed'));
    if (Number.isFinite(seed)) out.seed = seed;
  } catch (e) {
    // No window / no query string (tests): plain defaults.
  }
  return out;
}

const query = readQuery();

// --- The shared game object --------------------------------------------------
// Every subsystem reads and writes this one object; nothing else holds
// game state. Fields are mirrored defensively because different modules
// read the same fact from different places (player.heat vs game.wanted
// vs game.heat; game.missionTarget vs game.mission.target).
const canvas = (typeof document !== 'undefined') ? document.getElementById('game') : null;

const game = {
  title: GAME_TITLE,
  state: 'title', // 'title' | 'playing' | 'paused' | 'gameover'
  paused: false,
  now: 0,
  dt: FRAME_DT,
  time: { now: 0, hour: 12, dayFraction: 0.5 },
  hour: 12,
  timeOfDay: 0.5,
  nightFactor: 0,
  isNight: false,
  world: null,
  player: null,
  cars: [],
  peds: [],
  pedestrians: [],
  enemies: [],
  bullets: [],
  particles: [],
  pickups: [],
  skids: [],
  input: null,
  audio: null,
  radio: null,
  radioStation: 'Bay FM',
  weapons: null,
  combat: null,
  police: null,
  cops: [],
  roadblocks: [],
  helicopter: null,
  garage: null,
  garageOpen: false,
  autopilot: null,
  autopilotEnabled: false,
  autopilotMode: null, // null | mission id | 'arc'
  autopilotDrove: false,
  hud: null,
  renderer: null,
  saveSlots: null,
  livingCity: null,
  missionsHandle: null,
  policeHandle: null,
  act2Handle: null,
  vehiclesHandle: null,
  mission: null,
  missionTarget: null,
  objectiveTarget: null,
  objectiveText: '',
  dialog: { open: false, visible: false, fixer: '', text: '', mission: null, reward: 0 },
  missionDialog: null,
  completedMissions: [],
  highestMission: null,
  missionComplete: false,
  missionCompleteId: null,
  missionStartedAt: 0,
  missionStageStartedAt: 0,
  wanted: { heat: 0, stars: 0 },
  heat: 0,
  sprayShop: { x: 1800, y: 2600, radius: 150 },
  helicopterForced: false,
  spotlightOnPlayer: false,
  heatDecayBlocked: false,
  helicopterActive: false,
  gameOver: null,
  courier: null,
  chaseInfo: null,
  lastGunshot: null,
  muzzleFlash: null,
  lastPickup: null,
  garagePurchase: null,
  shotPose: null,
  shotStep: 0,
  shotExtras: null,
  roadblockTarget: null,
  policeChaseCount: 0,
  statusMessage: '',
  wiring: {},
  rng: Math.random,
};

game.missionDialog = game.dialog;

// The world and the player come first: everything else stands on them.
game.world = createWorld(WORLD_SEED_USED);
const spawnPoint = (game.world && game.world.spawn) || PLAYER_SPAWN;
game.player = createPlayer(spawnPoint.x, spawnPoint.y);
game.sprayShop = {
  x: (LANDMARKS.sprayShop && LANDMARKS.sprayShop.x) || 1800,
  y: (LANDMARKS.sprayShop && LANDMARKS.sprayShop.y) || 2600,
  radius: 150,
};

// Input: the createInput object IS game.input. Its `down` set is aliased
// as `keys` because player.js and the autopilot both read input.keys,
// and the per-frame edge fields the gameplay code reads (aimX / aimY /
// mouseDown / mousePressed / interactPressed / ePressed) are synced by
// the loop before any update runs.
game.input = createInput(canvas);
// The input object exposes `down` as the Set of held key codes, but
// player.js reads `input.down` as a boolean ("is the Down key held").
// A Set is always truthy, so without this bridge Rook would walk
// south at full speed forever. Bridge the four direction booleans
// (plus sprint / handbrake) as getters over the key Set, keeping the
// Set itself available as `keys` for player.js and the autopilot.
const heldKeySet = game.input.down;
game.input.keys = heldKeySet;
for (const [prop, codes] of [
  ['down', ['KeyS', 'ArrowDown']],
  ['up', ['KeyW', 'ArrowUp']],
  ['left', ['KeyA', 'ArrowLeft']],
  ['right', ['KeyD', 'ArrowRight']],
  ['sprint', ['ShiftLeft', 'ShiftRight']],
  ['handbrake', ['Space']],
]) {
  Object.defineProperty(game.input, prop, {
    configurable: true,
    enumerable: true,
    get() { return codes.some((c) => heldKeySet.has(c)); },
  });
}
if (canvas) game.input.attach(canvas);

// Subsystems, each constructed against the shared game object.
game.audio = createAudio(game);
game.radio = createRadio(game);
game.weapons = createWeaponSystem(game);
game.combat = createCombat(game);
game.pedestrians = createPedestrians(game);
game.pedestrianSystem = game.pedestrians;
game.autopilot = createAutopilot(game);
game.garage = createFixerGarage(game);
game.helicopter = createPoliceHelicopter(game);
game.livingCity = createLivingCity(game);
game.hud = createHud(game);
game.renderer = createRenderer(canvas, game, game.world);
game.saveSlots = createSaveSlots();

// Police list: an ARRAY (player.js iterates it for heat decay and
// arrest checks) that also carries .cops / .cars / .roadblocks
// properties for the renderer and HUD, which read those names.
const policeList = [];
policeList.cops = [];
policeList.cars = [];
policeList.roadblocks = [];
game.police = policeList;
game.cops = policeList;
game.roadblocks = policeList.roadblocks;

// A live view of the mission arc: the missions module's MISSION_ARC
// first, act2's extension second, the spec fallback table last. Built
// once at boot (and rebuilt if act2 registers late).
let missionArc = [];
let missionArcById = {};

function rebuildMissionArc() {
  const seen = new Set();
  const arc = [];
  const fromModule = pickValue(MissionsMod, ['MISSION_ARC', 'ARC', 'MISSIONS']);
  const act2Arc = pickValue(Act2Mod, ['MISSION_ARC_ACT2', 'ACT2_MISSIONS', 'ACT2_ARC', 'MISSIONS']);
  const sources = [];
  if (Array.isArray(fromModule)) sources.push(fromModule);
  if (Array.isArray(act2Arc)) sources.push(act2Arc);
  for (const list of sources) {
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      arc.push(entry);
    }
  }
  for (const id of MISSION_ORDER) {
    if (seen.has(id)) continue;
    seen.add(id);
    arc.push(Object.assign({ id }, MISSION_FALLBACK_PLAN[id]));
  }
  arc.sort((a, b) => MISSION_ORDER.indexOf(a.id) - MISSION_ORDER.indexOf(b.id));
  missionArc = arc;
  missionArcById = {};
  for (const entry of arc) missionArcById[entry.id] = entry;
  return arc;
}

function missionDef(id) {
  if (!id) return null;
  const mod = missionArcById[id] || null;
  if (mod) {
    // The Act 2 entries describe their stages by label only (no kind,
    // landmark or coordinates), which the fallback driver cannot run:
    // a goto stage with no target never completes — the m9 probe
    // watched the car arrive at the hideout and sit there 140+ s
    // with game.missionTarget null while the autopilot (which carries
    // its own plan) had driven to the right place. When a module
    // entry cannot drive, the spec fallback plan for that mission
    // wins: it carries the same rewards and limits plus the stage
    // kinds, landmarks, cover heat and helicopter the driver needs.
    // Entries whose stages do carry a kind, a landmark or coordinates
    // (m1–m8) are untouched.
    const stages = mod.stages || mod.checkpoints || null;
    const usable = Array.isArray(stages) && stages.some((s) => s
      && (s.kind || s.landmark || (s.target && typeof s.target.x === 'number')
        || (typeof s.x === 'number' && typeof s.y === 'number')));
    if (usable) return mod;
    if (MISSION_FALLBACK_PLAN[id]) return MISSION_FALLBACK_PLAN[id];
    return mod;
  }
  return MISSION_FALLBACK_PLAN[id] || null;
}

function nextMissionId(id) {
  const idx = MISSION_ORDER.indexOf(id);
  if (idx < 0 || idx >= MISSION_ORDER.length - 1) return null;
  return MISSION_ORDER[idx + 1];
}

// --- Adapters for the older modules ---------------------------------------
// Each adapter probes the module at runtime: try the factory names
// first (the fresh modules all use createX(game)), then standalone
// functions. Whatever is found is recorded in game.wiring so the
// debug snapshot says which path is live; whatever is missing falls
// back to the small spec-driven implementation in this file.

function buildMissionsHandle() {
  const factory = pickFn(MissionsMod, [
    'createMissions', 'createMissionSystem', 'createMissionArc', 'initMissions', 'makeMissions',
  ]);
  let handle = null;
  if (factory) {
    try { handle = factory(game); } catch (e) { handle = null; }
  }
  if (!handle && typeof MissionsMod.default === 'function') {
    try {
      const made = MissionsMod.default(game);
      if (made && typeof made === 'object') handle = made;
    } catch (e) { /* default is not a factory; ignore */ }
  }
  if (!handle) {
    // Side-effect-free scan: an object-valued export (or the default
    // export) that carries a startMission method is the system handle.
    const candidates = [];
    if (MissionsMod.default && typeof MissionsMod.default === 'object') candidates.push(MissionsMod.default);
    for (const key of Object.keys(MissionsMod)) {
      const v = MissionsMod[key];
      if (v && typeof v === 'object') candidates.push(v);
    }
    for (const cand of candidates) {
      if (typeof cand.startMission === 'function') { handle = cand; break; }
    }
  }
  game.missionsHandle = handle;
  const hasStart = !!(handle && typeof handle.startMission === 'function')
    || typeof MissionsMod.startMission === 'function';
  game.wiring.missions = hasStart ? 'module' : 'fallback';
  game.wiring.missionsFactory = factory ? factory.name : (handle ? 'default' : 'none');
  return handle;
}

function buildPoliceHandle() {
  const factory = pickFn(PoliceMod, [
    'createPolice', 'createPoliceSystem', 'createWantedSystem', 'initPolice', 'makePolice',
  ]);
  let handle = null;
  if (factory) {
    try { handle = factory(game); } catch (e) { handle = null; }
  }
  if (!handle && typeof PoliceMod.default === 'function') {
    try {
      const made = PoliceMod.default(game);
      if (made && typeof made === 'object') handle = made;
    } catch (e) { /* ignore */ }
  }
  game.policeHandle = handle;
  const hasUpdate = !!(handle && typeof handle.update === 'function')
    || typeof PoliceMod.updatePolice === 'function'
    || typeof PoliceMod.update === 'function'
    || typeof PoliceMod.updateWantedHeat === 'function';
  game.wiring.police = hasUpdate ? 'module' : 'fallback';
  game.wiring.policeFactory = factory ? factory.name : (handle ? 'default' : 'none');
  return handle;
}

function buildAct2Handle() {
  // Act2 extends the arc with m9-m12. Try its registration hooks first;
  // a plain array export is merged by rebuildMissionArc() instead.
  const register = pickFn(Act2Mod, [
    'registerAct2', 'applyAct2', 'extendMissions', 'extendArc', 'addAct2Missions',
    'initAct2', 'setupAct2', 'createAct2', 'makeAct2',
  ]);
  let handle = null;
  if (register) {
    try {
      const made = register(game, game.missionsHandle);
      if (made && typeof made === 'object') handle = made;
    } catch (e) {
      try {
        const made = register(game);
        if (made && typeof made === 'object') handle = made;
      } catch (e2) { /* registration failed; the arc table still covers m9-m12 */ }
    }
  }
  if (!handle && typeof Act2Mod.default === 'function') {
    try {
      const made = Act2Mod.default(game);
      if (made && typeof made === 'object') handle = made;
    } catch (e) { /* ignore */ }
  }
  game.act2Handle = handle;
  game.wiring.act2 = register ? 'registered' : (handle ? 'handle' : 'arc-table');
  return handle;
}

function buildVehiclesHandle() {
  const factory = pickFn(VehiclesMod, [
    'createVehicles', 'createVehicleSystem', 'initVehicles', 'makeVehicles',
  ]);
  let handle = null;
  if (factory) {
    try { handle = factory(game); } catch (e) { handle = null; }
  }
  game.vehiclesHandle = handle;
  const hasCar = !!(handle && (typeof handle.createCar === 'function' || typeof handle.createVehicle === 'function'))
    || typeof VehiclesMod.createCar === 'function'
    || typeof VehiclesMod.createVehicle === 'function';
  game.wiring.vehicles = hasCar ? 'module' : 'traffic';
  return handle;
}

// Spawn one car, preferring the vehicles module's factory when it
// offers one, otherwise the traffic module's (same shape, same fields).
function spawnCar(type, x, y, opts) {
  const options = opts || {};
  const maker = (game.vehiclesHandle && (game.vehiclesHandle.createCar || game.vehiclesHandle.createVehicle))
    || VehiclesMod.createCar || VehiclesMod.createVehicle || null;
  let car = null;
  if (maker) {
    // The factory takes (type, x, y, options). An earlier version
    // passed (x, y, type, options) instead, so the courier was born
    // with y='sedan': every distance from it came back NaN, the
    // road-point lookup returned null, and the chase driver threw
    // on the first m2 frame — killing the whole frame loop.
    try { car = maker(type, x, y, options); } catch (e) { car = null; }
  }
  // A maker that answers with non-numeric coordinates is discarded
  // in favour of the known-good factory, whatever it did.
  // NOTE the two factories disagree on argument order: the vehicles
  // module's createCar is (type, x, y), but the traffic module's
  // createCar imported above is (x, y, type) — keep them straight.
  if (!car || typeof car.x !== 'number' || typeof car.y !== 'number') {
    car = createCar(x, y, type, options);
  }
  if (car && options.cruise !== undefined) car.cruise = options.cruise;
  if (car && options.isCourier) car.isCourier = true;
  if (car && options.courier) car.courier = true;
  game.cars.push(car);
  return car;
}

function spawnPlayerCar(type, color) {
  const p = game.player;
  const car = spawnCar(type || 'sports', p.x, p.y, {
    parked: false, driver: 'player', angle: p.angle || 0, color,
  });
  car.player = true;
  p.car = car;
  p.onFoot = false;
  p.x = car.x;
  p.y = car.y;
  return car;
}

// --- The single mission-start path ------------------------------------------
// D3 proved that a mission handoff needs ONE path: install the new
// target, switch the driver to it, make the car movable, drop the old
// mission's leftovers. Every start — first mission, next mission after
// a completion, retry after a failure, autopilot jump — comes here.
// If the missions module exposes startMission, it is called first and
// this path then VERIFIES the target was installed; if the module
// offers nothing usable, the fallback driver below runs the mission.

const missionRuntime = {
  active: false,
  id: null,
  stage: 0,
  stageKind: null,
  stageTarget: null,
  startedAt: 0,
  stageStartedAt: 0,
  ramHits: 0,
  lastRamAt: -10,
  courier: null,
  collectTotal: 0,
  collectDone: 0,
  arenaSpawned: false,
  arenaId: null,
  arenaStage: -1,
  escapeHeatSet: false,
  offerCooldownUntil: 0,
  lastOfferedId: null,
  failNoted: false,
};

function clearMissionLeftovers(nextId) {
  // The courier belongs to m2 only; leaving it attached after m2 ends
  // is what froze the D3 handoff (the driver kept chasing a ghost).
  if (nextId !== 'm2') {
    game.courier = null;
    if (game.mission) game.mission.courier = null;
    missionRuntime.courier = null;
  }
  // Old arena enemies and money drops never carry into the next mission.
  if (Array.isArray(game.enemies)) {
    for (const e of game.enemies) e.alive = false;
    game.enemies.length = 0;
  }
  if (Array.isArray(game.pickups)) {
    game.pickups = game.pickups.filter((pk) => pk && pk.kind !== 'money' && pk.kind !== 'arena');
  }
  missionRuntime.arenaSpawned = false;
  missionRuntime.arenaId = null;
  missionRuntime.arenaStage = -1;
  missionRuntime.escapeHeatSet = false;
  missionRuntime.ramHits = 0;
  missionRuntime.collectDone = 0;
}

function targetFromStageDef(def, stage) {
  if (!def) return null;
  const stages = def.stages || def.checkpoints || null;
  let step = null;
  if (Array.isArray(stages)) step = stages[Math.min(stage, stages.length - 1)];
  else if (def.target) step = { kind: 'goto', target: def.target };
  if (!step) return null;
  if (step.target && typeof step.target.x === 'number') {
    return { x: step.target.x, y: step.target.y, label: step.label || step.name || 'target', static: true };
  }
  if (step.landmark) {
    const pt = landmarkPoint(step.landmark);
    if (pt) return pt;
  }
  if (step.x !== undefined && step.y !== undefined) {
    return { x: step.x, y: step.y, label: step.label || 'target', static: true };
  }
  return null;
}

function installStageTarget(id, stage) {
  const def = missionDef(id);
  const pt = targetFromStageDef(def, stage);
  if (pt) {
    game.missionTarget = pt;
    game.objectiveTarget = pt;
    if (game.mission) {
      game.mission.target = pt;
      game.mission.checkpoint = pt;
    }
    return pt;
  }
  return game.missionTarget || null;
}

function stageObjectiveText(def, stage) {
  if (!def) return '';
  const stages = def.stages || [];
  const step = stages[Math.min(stage, stages.length - 1)];
  const name = (def.name || def.id || '').toUpperCase();
  if (!step) return name;
  switch (step.kind) {
    case 'goto': {
      const pt = targetFromStageDef(def, stage);
      return name + ' — Drive to ' + (pt ? pt.label : 'the marker');
    }
    case 'chase': return name + ' — Ram the courier car';
    case 'shootout': return name + ' — Clear the arena';
    case 'collect': return name + ' — Collect the money drops (' + missionRuntime.collectDone + '/' + missionRuntime.collectTotal + ')';
    case 'escape': return name + ' — ESCAPE THE POLICE — Lose the cops';
    case 'garage': return name + ' — Buy an upgrade at the Fixer Garage';
    default: return name;
  }
}

function applyMissionCover(def) {
  if (!def) return;
  // Cover levels are set AFTER the mission starts (the mission itself
  // adds heat on start, so setting cover first would be overwritten).
  if (typeof def.coverHeat === 'number') {
    game.player.heat = def.coverHeat;
    game.player.stars = computeWantedStars(def.coverHeat);
  } else if (typeof def.startHeat === 'number') {
    game.player.heat = def.startHeat;
    game.player.stars = computeWantedStars(def.startHeat);
  } else if (typeof def.wantedHeat === 'number') {
    game.player.heat = def.wantedHeat;
    game.player.stars = computeWantedStars(def.wantedHeat);
  }
  if (def.night || def.isNight || def.timeOfDay === 'night') {
    game.time.dayFraction = 0.02;
    game.time.hour = 0.5;
    game.hour = 0.5;
    game.timeOfDay = 0.02;
  }
  if (def.heli || def.helicopter) game.helicopterForced = true;
  else if (def.id !== 'm9' && def.id !== 'm12') game.helicopterForced = false;
}

function callModuleStartMission(id) {
  const handle = game.missionsHandle;
  if (handle && typeof handle.startMission === 'function') {
    try {
      const out = handle.startMission(id);
      return out !== false;
    } catch (e) { return false; }
  }
  if (typeof MissionsMod.startMission === 'function') {
    try {
      const out = MissionsMod.startMission(game, id);
      return out !== false;
    } catch (e) {
      try {
        const out = MissionsMod.startMission(id);
        return out !== false;
      } catch (e2) { return false; }
    }
  }
  return false;
}

function startMissionById(id, opts) {
  const options = opts || {};
  const def = missionDef(id);
  if (!def) return false;
  // One path, in order: drop the old mission's leftovers, let the
  // module start the mission, verify the target is installed, apply
  // cover after the start, reset the driver, publish the objective.
  clearMissionLeftovers(id);
  closeDialog();
  const moduleStarted = callModuleStartMission(id);
  if (!game.mission || game.mission.id !== id) {
    game.mission = {
      id,
      name: def.name || id,
      fixer: def.fixer || 'Mara',
      reward: def.reward || 0,
      stage: 0,
      objective: '',
      target: null,
      enemies: game.enemies,
      checkpoints: null,
    };
  } else {
    game.mission.stage = 0;
    game.mission.name = def.name || game.mission.name;
    game.mission.fixer = def.fixer || game.mission.fixer;
    game.mission.reward = def.reward || game.mission.reward || 0;
  }
  missionRuntime.active = true;
  missionRuntime.id = id;
  missionRuntime.stage = 0;
  missionRuntime.startedAt = game.now;
  missionRuntime.stageStartedAt = game.now;
  missionRuntime.failNoted = false;
  game.missionStartedAt = game.now;
  game.missionStageStartedAt = game.now;
  game.missionComplete = false;
  game.missionCompleteId = null;
  applyMissionCover(def);
  // Verify the target: if the module installed nothing, install it
  // from the arc definition so the driver never chases a ghost.
  const published = (game.missionTarget && typeof game.missionTarget.x === 'number')
    ? game.missionTarget
    : (game.mission && game.mission.target);
  if (!published || (published && typeof published.x !== 'number')) {
    installStageTarget(id, 0);
  } else {
    game.missionTarget = published;
    game.objectiveTarget = published;
  }
  const step = (def.stages || [])[0];
  missionRuntime.stageKind = step ? step.kind : 'goto';
  missionRuntime.stageTarget = game.missionTarget;
  game.objectiveText = stageObjectiveText(def, 0);
  if (game.mission) game.mission.objective = game.objectiveText;
  // Make the car movable again and point the driver at the new target:
  // a stale route / recover flag is what locked the car in the D3 freeze.
  if (game.player && game.player.car) {
    const car = game.player.car;
    car.route = [];
    car.routeDest = null;
    car.recover = false;
    car.reverseT = 0;
    car.stuckT = 0;
  }
  if (game.autopilot && typeof game.autopilot.resetForNewMission === 'function') {
    try { game.autopilot.resetForNewMission(id, 0); } catch (e) { /* driver reset is best-effort */ }
  }
  if (game.wiring.missions === 'fallback') beginFallbackStage(id, 0);
  if (options.announce !== false) {
    game.statusMessage = (def.name || id) + ' started';
  }
  return true;
}

// Move to a later stage of the current mission through the same single
// path as a fresh start: reinstall the target, reset the driver, clear
// stale car state. Used for handoffs the module reports (stage change)
// and for the fallback driver's own stage advances.
function advanceMissionStage(id, stage) {
  const def = missionDef(id);
  if (!def) return false;
  if (!game.mission || game.mission.id !== id) {
    game.mission = {
      id, name: def.name || id, fixer: def.fixer || 'Mara',
      reward: def.reward || 0, stage, objective: '', target: null, enemies: game.enemies,
    };
  }
  game.mission.stage = stage;
  missionRuntime.id = id;
  missionRuntime.stage = stage;
  missionRuntime.stageStartedAt = game.now;
  game.missionStageStartedAt = game.now;
  const published = game.missionTarget;
  installStageTarget(id, stage);
  if (!game.missionTarget && published && typeof published.x === 'number') {
    game.missionTarget = published;
    game.objectiveTarget = published;
  }
  const step = (def.stages || [])[Math.min(stage, (def.stages || []).length - 1)];
  missionRuntime.stageKind = step ? step.kind : 'goto';
  missionRuntime.stageTarget = game.missionTarget;
  game.objectiveText = stageObjectiveText(def, stage);
  if (game.mission) game.mission.objective = game.objectiveText;
  if (game.player && game.player.car) {
    const car = game.player.car;
    car.route = [];
    car.routeDest = null;
    car.recover = false;
    car.reverseT = 0;
    car.stuckT = 0;
  }
  if (game.autopilot && typeof game.autopilot.resetForNewMission === 'function') {
    try { game.autopilot.resetForNewMission(id, stage); } catch (e) { /* best-effort */ }
  }
  if (game.wiring.missions === 'fallback') beginFallbackStage(id, stage);
  return true;
}

function completeMission(id) {
  const def = missionDef(id);
  if (!game.completedMissions.includes(id)) game.completedMissions.push(id);
  game.highestMission = id;
  game.missionComplete = true;
  game.missionCompleteId = id;
  if (def && typeof def.reward === 'number') {
    // The module pays the reward when it completes a mission; only pay
    // here in fallback mode, where no module is running the economy.
    if (game.wiring.missions === 'fallback') game.player.cash += def.reward;
  }
  missionRuntime.active = false;
  game.mission = null;
  game.missionTarget = null;
  game.objectiveTarget = null;
  game.objectiveText = '';
  game.helicopterForced = false;
  autosaveNow();
  const next = nextMissionId(id);
  if (next && game.autopilotMode === 'arc') {
    // Chain straight into the next offer: the autopilot accepts it and
    // the handoff runs through startMissionById, never a side path.
    offerMission(next);
  } else if (next) {
    offerMission(next);
  }
  return true;
}

function failMission(id) {
  // A failed mission restarts from its checkpoint (stage 0), never
  // from the start of the campaign.
  const def = missionDef(id);
  if (def) game.statusMessage = (def.name || id) + ' failed — restarting from the checkpoint';
  startMissionById(id, { announce: false });
  return true;
}

// --- Mission dialog ----------------------------------------------------------
// The offer dialog is the story beat before a mission: fixer, hook,
// reward, Accept / Not Now. Accept runs the single start path. The
// autopilot accepts by pressing E, which lands here through
// game.acceptDialog (the autopilot calls it directly) and through the
// dialog branch reading the interact edge.

function offerMission(id) {
  const def = missionDef(id);
  if (!def) return false;
  if (game.now < missionRuntime.offerCooldownUntil && missionRuntime.lastOfferedId === id) return false;
  const hook = def.hook || def.dialog || ((def.fixer || 'Mara') + ': A job is waiting. $' + (def.reward || 0) + ' when it is done.');
  game.dialog = {
    open: true,
    visible: true,
    fixer: def.fixer || 'Mara',
    text: hook,
    mission: def.name || id,
    missionId: id,
    reward: def.reward || 0,
    objective: stageObjectiveText(def, 0),
  };
  game.missionDialog = game.dialog;
  missionRuntime.lastOfferedId = id;
  showDialogDom();
  return true;
}

function closeDialog() {
  game.dialog.open = false;
  game.dialog.visible = false;
  game.missionDialog = game.dialog;
  hideDialogDom();
}

function acceptDialog() {
  const d = game.dialog;
  if (!d || (!d.open && !d.visible)) return false;
  const id = d.missionId || (d.mission && missionArcById[d.mission]) || null;
  // Let the module accept first when it owns the offer.
  const handle = game.missionsHandle;
  if (handle && typeof handle.acceptDialog === 'function') {
    try { handle.acceptDialog(); } catch (e) { /* fall through to the single path */ }
  } else if (handle && typeof handle.acceptMission === 'function') {
    try { handle.acceptMission(); } catch (e) { /* fall through */ }
  } else if (typeof MissionsMod.acceptDialog === 'function') {
    try { MissionsMod.acceptDialog(game); } catch (e) { /* fall through */ }
  }
  closeDialog();
  if (id && missionDef(id)) {
    startMissionById(id);
    return true;
  }
  if (game.mission && game.mission.id) return true;
  return true;
}

function declineDialog() {
  const id = game.dialog && game.dialog.missionId;
  closeDialog();
  missionRuntime.offerCooldownUntil = game.now + DIALOG_COOLDOWN_SEC;
  if (id) missionRuntime.lastOfferedId = id;
  return true;
}

game.acceptDialog = acceptDialog;
game.startMission = startMissionById;
game.addHeat = function addHeatBound(amount) {
  addHeat(game, amount);
};

// --- Fallback mission driver -------------------------------------------------
// Runs ONLY when the missions module offers no startMission. It drives
// the same stage kinds the autopilot already understands (goto / chase
// / shootout / collect / escape / garage) from the spec fallback plan,
// so the arc stays completable even with no module at all.

function beginFallbackStage(id, stage) {
  const def = missionDef(id);
  if (!def) return;
  const step = (def.stages || [])[Math.min(stage, (def.stages || []).length - 1)];
  if (!step) return;
  // One arena per mission + stage, however many times this stage is
  // (re)entered: startMissionById and the handoff watch both call
  // here for the same first sight, and the old blind reset of
  // arenaSpawned made each call spawn a full arena — m8 ran with 6
  // enemies instead of the spec's 3, and m6 got 10 money drops
  // instead of 5. The stamp below is the guard; a fresh start clears
  // it in clearMissionLeftovers, a new stage carries a new stamp.
  if (missionRuntime.arenaId === id && missionRuntime.arenaStage === stage) return;
  missionRuntime.arenaId = id;
  missionRuntime.arenaStage = stage;
  missionRuntime.stageKind = step.kind;
  missionRuntime.escapeHeatSet = false;
  if (step.kind === 'shootout' && !missionRuntime.arenaSpawned) {
    const count = step.enemies || 3;
    const cx = game.player.x;
    const cy = game.player.y;
    if (game.combat && typeof game.combat.spawnArenaEnemies === 'function') {
      try { game.combat.spawnArenaEnemies(cx, cy, count); } catch (e) { /* arena is best-effort */ }
    }
    if (game.combat) {
      try {
        game.combat.spawnHealthPickup(cx - 150, cy + 120);
        game.combat.spawnHealthPickup(cx + 150, cy - 120);
        game.combat.spawnAmmoPickup(cx, cy + 160, 'pistol');
      } catch (e) { /* pickups are best-effort */ }
    }
    missionRuntime.arenaSpawned = true;
  }
  if (step.kind === 'chase' && !missionRuntime.courier) {
    const p = game.player;
    const courier = spawnCar('sedan', p.x + 300, p.y, {
      driver: 'courier', angle: 0, cruise: 380, isCourier: true,
    });
    courier.route = [];
    courier.routeDest = null;
    missionRuntime.courier = courier;
    game.courier = courier;
    if (game.mission) game.mission.courier = courier;
  }
  if (step.kind === 'collect') {
    missionRuntime.collectTotal = COLLECT_DROP_SPOTS.length;
    missionRuntime.collectDone = 0;
    for (const spot of COLLECT_DROP_SPOTS) {
      const pt = landmarkPoint(spot);
      if (!pt) continue;
      game.pickups.push({ x: pt.x, y: pt.y, kind: 'money', taken: false, label: 'money drop' });
    }
  }
  if (step.kind === 'escape' && !missionRuntime.escapeHeatSet) {
    if (game.player.heat < 30) {
      game.player.heat = 52;
      game.player.stars = computeWantedStars(52);
    }
    missionRuntime.escapeHeatSet = true;
  }
  if (step.kind === 'garage') {
    game.objectiveText = stageObjectiveText(def, stage);
  }
}

function fallbackCourierStep(dt) {
  const courier = missionRuntime.courier;
  if (!courier || courier.wrecked) return;
  // The courier cruises the road graph; it never reverses except at a
  // dead end (the route builder handles that). Chase speed is the
  // autopilot's business; here the courier just keeps moving.
  const dest = courier.routeDest || { x: 600, y: 600 };
  // Drive at the courier's own cruise (380, cut 55% per ram hit),
  // not 0: with cruise 0 the courier could only creep while turning
  // (the crawl rule) and stopped dead once aligned with its
  // waypoint — the probe watched it sit 184 from its waypoint,
  // speed 0, for 100+ seconds while the chase timed out.
  followMovingTarget(courier, { x: dest.x, y: dest.y }, courier.cruise || 380, dt, game.world, game.now);
  if (!courier.route || !courier.route.length) {
    const spots = [600, 1400, 2200, 2600];
    const tx = spots[Math.floor(Math.random() * spots.length)];
    const ty = spots[Math.floor(Math.random() * spots.length)];
    courier.routeDest = { x: tx, y: ty };
  }
  // A ram hit counts within 70 while the player is faster than 120;
  // each hit cuts the courier's cruise to 55%.
  const p = game.player;
  if (p && !p.onFoot && p.car) {
    const d = dist(p, courier);
    const speed = Math.abs(p.car.speed || 0);
    if (d < RAM_HIT_RADIUS && speed > RAM_HIT_SPEED && game.now - missionRuntime.lastRamAt > RAM_HIT_COOLDOWN) {
      missionRuntime.lastRamAt = game.now;
      missionRuntime.ramHits += 1;
      courier.cruise = (courier.cruise || 380) * 0.55;
      if (game.audio && typeof game.audio.play === 'function') {
        try { game.audio.play('pickup'); } catch (e) { /* ignore */ }
      }
    }
  }
}

function fallbackCollectStep() {
  const p = game.player;
  for (const pk of game.pickups) {
    if (!pk || pk.taken || pk.kind !== 'money') continue;
    // A drop counts at the same reach radius a goto stage counts as
    // reached. The old 40 was tighter than the 70 the driving layer
    // treats as "arrived": the m6 probe watched the car sit 69 from
    // a drop for 70+ seconds — route empty, "arrived", speed frozen —
    // while the drop never counted, so the stage timed out at 0/5.
    if (dist(p, pk) < MISSION_REACH_RADIUS) {
      pk.taken = true;
      missionRuntime.collectDone += 1;
      if (game.audio && typeof game.audio.play === 'function') {
        try { game.audio.play('pickup'); } catch (e) { /* ignore */ }
      }
    }
  }
  const def = missionDef(missionRuntime.id);
  if (def) game.objectiveText = stageObjectiveText(def, missionRuntime.stage);
  if (game.mission) game.mission.objective = game.objectiveText;
}

function updateFallbackMission(dt) {
  if (!missionRuntime.active || !missionRuntime.id) return;
  const id = missionRuntime.id;
  const stage = missionRuntime.stage;
  const def = missionDef(id);
  if (!def) return;
  const step = (def.stages || [])[Math.min(stage, (def.stages || []).length - 1)];
  if (!step) {
    completeMission(id);
    return;
  }
  // Time limit: fail back to stage 0.
  const elapsed = game.now - missionRuntime.startedAt;
  if (elapsed > (def.limit || 600)) {
    failMission(id);
    return;
  }
  let done = false;
  switch (step.kind) {
    case 'goto': {
      const target = game.missionTarget;
      if (target && dist(game.player, target) < MISSION_REACH_RADIUS) done = true;
      break;
    }
    case 'chase': {
      fallbackCourierStep(dt);
      if (missionRuntime.ramHits >= 4) done = true;
      break;
    }
    case 'shootout': {
      const left = game.combat ? game.combat.enemiesAlive() : 0;
      if (missionRuntime.arenaSpawned && left === 0) done = true;
      break;
    }
    case 'collect': {
      fallbackCollectStep();
      if (missionRuntime.collectDone >= missionRuntime.collectTotal) done = true;
      break;
    }
    case 'escape': {
      if (game.player.heat <= ESCAPE_DONE_HEAT) done = true;
      break;
    }
    case 'garage': {
      if (game.garage && typeof game.garage.hasPurchased === 'function' && game.garage.hasPurchased()) done = true;
      break;
    }
    default: {
      const target = game.missionTarget;
      if (target && dist(game.player, target) < MISSION_REACH_RADIUS) done = true;
      break;
    }
  }
  if (!done) return;
  const stages = def.stages || [];
  if (stage + 1 < stages.length) {
    advanceMissionStage(id, stage + 1);
  } else {
    completeMission(id);
  }
}

// --- Fallback police ----------------------------------------------------------
// Runs ONLY when the police module offers no update. Spec section 1:
// foot cops at 1 star, patrol cars from 2 stars, roadblocks at 4-5
// stars, arrest only by the player.js rule (a foot cop within 30 of a
// slow on-foot player for 1.2s). Heat itself lives on the player.

const fallbackPolice = {
  nextSpawnAt: 0,
  roadblockAt: -100,
};

function fallbackPoliceUpdate(dt) {
  const p = game.player;
  const stars = p.stars || 0;
  const now = game.now;
  // Foot cops: wanted 1 star and up, at most 3, walking at Rook.
  const wantFoot = stars >= 1 ? Math.min(3, stars) : 0;
  let foot = policeList.cops.filter((c) => c && c.kind === 'foot' && !c.dead);
  while (foot.length < wantFoot && now >= fallbackPolice.nextSpawnAt) {
    const angle = Math.random() * Math.PI * 2;
    const cx = clamp(p.x + Math.cos(angle) * 500, 60, 3140);
    const cy = clamp(p.y + Math.sin(angle) * 500, 60, 3140);
    const cop = { x: cx, y: cy, angle, kind: 'foot', dead: false, health: 50, speed: 130 };
    policeList.push(cop);
    policeList.cops.push(cop);
    foot.push(cop);
    fallbackPolice.nextSpawnAt = now + 1.5;
  }
  for (const cop of foot) {
    if (!cop || cop.dead) continue;
    const d = dist(cop, p);
    if (d > 12) {
      const a = Math.atan2(p.y - cop.y, p.x - cop.x);
      cop.angle = a;
      const step = Math.min(d, 130 * dt);
      cop.x += Math.cos(a) * step;
      cop.y += Math.sin(a) * step;
    }
  }
  // Patrol cars: wanted 2 stars and up, at most 4, driving at Rook.
  const wantCars = stars >= 2 ? Math.min(4, stars - 1) : 0;
  let patrol = policeList.cars.filter((c) => c && !c.wrecked);
  while (patrol.length < wantCars && now >= fallbackPolice.nextSpawnAt) {
    const angle = Math.random() * Math.PI * 2;
    const pt = nearestRoadPoint(
      clamp(p.x + Math.cos(angle) * 550, 60, 3140),
      clamp(p.y + Math.sin(angle) * 550, 60, 3140),
    );
    const car = spawnCar('police', pt.x, pt.y, { driver: 'police', cruise: 520 });
    car.isPolice = true;
    policeList.cars.push(car);
    patrol.push(car);
    fallbackPolice.nextSpawnAt = now + 1.5;
  }
  for (const car of patrol) {
    if (!car || car.wrecked) continue;
    driveCarToward(car, p.x, p.y, 520, dt, game.world, now, { finalLeg: false });
  }
  // Roadblocks at 4-5 stars: two barriers ahead of Rook on his road.
  if (stars >= 4) {
    if (policeList.roadblocks.length === 0 || now - fallbackPolice.roadblockAt > 12) {
      policeList.roadblocks.length = 0;
      const ahead = nearestRoadPoint(p.x + 300, p.y);
      policeList.roadblocks.push(
        { x: ahead.x, y: ahead.y, angle: 0 },
        { x: ahead.x, y: ahead.y + 400, angle: Math.PI / 2 },
      );
      fallbackPolice.roadblockAt = now;
    }
  } else if (policeList.roadblocks.length) {
    policeList.roadblocks.length = 0;
  }
  // Prune the dead and the far away; keep game.police an array.
  policeList.cops = policeList.cops.filter((c) => c && !c.dead);
  policeList.cars = policeList.cars.filter((c) => c && !c.wrecked);
  const kept = [];
  for (const cop of policeList) {
    if (!cop) continue;
    if (cop.kind === 'foot' && (cop.dead || dist(cop, p) > 1400)) continue;
    if (cop.isPolice || cop.type === 'police') continue; // patrol cars live in game.cars
    kept.push(cop);
  }
  policeList.length = 0;
  for (const cop of kept) policeList.push(cop);
  game.roadblocks = policeList.roadblocks;
}

// Sync the shared police array from a module handle that keeps its own
// cops / cars / roadblocks lists. The array shape is what player.js,
// the renderer and the HUD all read.
function syncPoliceFromModule() {
  const handle = game.policeHandle;
  if (!handle) return;
  const cops = Array.isArray(handle.cops) ? handle.cops
    : (Array.isArray(handle.footCops) ? handle.footCops : null);
  const cars = Array.isArray(handle.cars) ? handle.cars
    : (Array.isArray(handle.patrolCars) ? handle.patrolCars : null);
  const blocks = Array.isArray(handle.roadblocks) ? handle.roadblocks : null;
  if (!cops && !cars && !blocks) {
    // The module may write game.police itself; if it replaced the
    // array with an object, rebuild the array from its lists.
    if (!Array.isArray(game.police)) {
      const rebuilt = [];
      rebuilt.cops = [];
      rebuilt.cars = [];
      rebuilt.roadblocks = [];
      game.police = rebuilt;
      game.cops = rebuilt;
    }
    return;
  }
  policeList.length = 0;
  policeList.cops = cops || policeList.cops;
  policeList.cars = cars || policeList.cars;
  policeList.roadblocks = blocks || policeList.roadblocks;
  for (const c of policeList.cops) if (c) policeList.push(c);
  for (const c of policeList.cars) if (c) policeList.push(c);
  game.police = policeList;
  game.cops = policeList;
  game.roadblocks = policeList.roadblocks;
}

function updatePolice(dt) {
  const handle = game.policeHandle;
  let ran = false;
  if (handle && typeof handle.update === 'function') {
    try { handle.update(dt); ran = true; } catch (e) { ran = false; }
  }
  if (!ran && typeof PoliceMod.updatePolice === 'function') {
    try { PoliceMod.updatePolice(game, dt); ran = true; } catch (e) { ran = false; }
  }
  if (!ran && typeof PoliceMod.update === 'function') {
    try { PoliceMod.update(game, dt); ran = true; } catch (e) { ran = false; }
  }
  if (!ran && typeof PoliceMod.updateWantedHeat === 'function') {
    try { PoliceMod.updateWantedHeat(game, dt); ran = true; } catch (e) { ran = false; }
  }
  if (ran) {
    syncPoliceFromModule();
  } else {
    fallbackPoliceUpdate(dt);
  }
  // The player module reads game.police as an array; never let a module
  // leave it as a bare object.
  if (!Array.isArray(game.police)) {
    game.police = policeList;
    game.cops = policeList;
  }
}

// --- Shot-pose driver ----------------------------------------------------------
// ?shot= poses are played simulations, not still lifes. The shots
// module sets the starting conditions; this driver keeps the chase
// moving (cover / night) and the shootout staged (mission) while the
// screenshot tool waits. The start pose stays on the title screen.

const poseRuntime = {
  id: null,
  target: null,
  enemiesSpawned: false,
  policeSpawned: false,
};

function setupShotPose() {
  const poseId = query.shot;
  if (!poseId) return false;
  const pose = getShotPose(poseId);
  if (!pose) return false;
  // Hooks the shots module calls when a pose needs police / a roadblock.
  game.spawnPoliceChase = function spawnPoliceChase(n) {
    const p = game.player;
    const count = n || 3;
    for (let i = 0; i < count; i++) {
      const behind = 130 + i * 120;
      const car = spawnCar('police', p.x, p.y + behind, {
        driver: 'police', cruise: 520, angle: -Math.PI / 2,
      });
      car.isPolice = true;
      policeList.cars.push(car);
    }
    return true;
  };
  game.spawnRoadblock = function spawnRoadblock(x, y) {
    policeList.roadblocks.push({ x, y, angle: 0 });
    game.roadblocks = policeList.roadblocks;
    return true;
  };
  applyShotSetup(game, poseId);
  poseRuntime.id = poseId;
  // The pose sets a plain-object car on the player; replace it with a
  // real car so physics, the renderer and the HUD all see the same one.
  const p = game.player;
  if (pose.playerCar && p.car && typeof p.car.id !== 'number') {
    const type = pose.playerCar.type || 'sports';
    const color = pose.playerCar.color || '#e74c3c';
    p.car = null;
    p.onFoot = true;
    const car = spawnPlayerCar(type, color);
    car.x = pose.playerStart.x;
    car.y = pose.playerStart.y;
    car.angle = pose.playerStart.angle || 0;
    p.x = car.x;
    p.y = car.y;
    p.angle = car.angle;
  }
  if (typeof pose.wantedHeat === 'number') {
    p.heat = pose.wantedHeat;
    p.stars = computeWantedStars(pose.wantedHeat);
  }
  if (pose.id === 'mission' && !poseRuntime.enemiesSpawned) {
    if (game.combat && typeof game.combat.spawnArenaEnemies === 'function') {
      try { game.combat.spawnArenaEnemies(p.x, p.y, pose.enemies || 3); } catch (e) { /* best-effort */ }
    }
    poseRuntime.enemiesSpawned = true;
  }
  if (pose.id === 'cover') poseRuntime.target = { x: 2600, y: 400 };
  if (pose.id === 'night') poseRuntime.target = { x: 2200, y: 400 };
  game.shotPose = poseId;
  return true;
}

function updateShotPose(dt) {
  if (!poseRuntime.id) return;
  const p = game.player;
  if (poseRuntime.id === 'start') return;
  if ((poseRuntime.id === 'cover' || poseRuntime.id === 'night') && poseRuntime.target) {
    // Drive the chase car up its road; loop back to the far end so the
    // chase never parks during the screenshot wait.
    if (!p.onFoot && p.car) {
      game.autopilotDrove = true;
      const res = driveCarToward(p.car, poseRuntime.target.x, poseRuntime.target.y, 420, dt, game.world, game.now, { finalLeg: true });
      p.x = p.car.x;
      p.y = p.car.y;
      p.angle = p.car.angle;
      p.speed = Math.abs(p.car.speed || 0);
      if (res.arrived) {
        poseRuntime.target = poseRuntime.target.y < 1600
          ? { x: poseRuntime.target.x, y: 2800 }
          : { x: poseRuntime.target.x, y: 400 };
      }
    }
    // The police behind keep chasing Rook's car.
    for (const car of policeList.cars) {
      if (!car || car.wrecked) continue;
      driveCarToward(car, p.x, p.y, 520, dt, game.world, game.now, { finalLeg: false });
    }
  }
}

// --- DOM overlays --------------------------------------------------------------
// The overlays live in index.html; this file only shows / hides them
// and fills their text. Ids: title-screen, pause-menu,
// game-over-screen, mission-dialog, controls-list, save-slots.

function el(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

function showOverlay(id) {
  const node = el(id);
  if (node) node.hidden = false;
}

function hideOverlay(id) {
  const node = el(id);
  if (node) node.hidden = true;
}

function showDialogDom() {
  const node = el('mission-dialog');
  if (!node) return;
  const fixer = node.querySelector('#dialog-fixer');
  const text = node.querySelector('#dialog-text');
  if (fixer) fixer.textContent = game.dialog.fixer || 'Mara';
  if (text) {
    text.textContent = game.dialog.text || '';
  }
  node.hidden = false;
}

function hideDialogDom() {
  const node = el('mission-dialog');
  if (node) node.hidden = true;
}

function refreshTitleSlots() {
  const list = el('save-slots');
  if (!list || !game.saveSlots) return;
  const rows = game.saveSlots.titleScreenRows();
  const items = list.querySelectorAll('li');
  rows.forEach((row, i) => {
    const li = items[i];
    if (!li) return;
    const span = li.querySelector('span');
    const btn = li.querySelector('button');
    if (span) span.textContent = row.title + (row.detail ? ' — ' + row.detail : '');
    if (btn) {
      btn.disabled = !row.canContinue;
      btn.setAttribute('data-slot', String(i + 1));
    }
  });
  const cont = el('continue-btn');
  if (cont) cont.disabled = !rows.some((r) => r.canContinue);
}

function showTitle() {
  game.state = 'title';
  game.paused = false;
  refreshTitleSlots();
  hideOverlay('pause-menu');
  hideOverlay('game-over-screen');
  hideDialogDom();
  showOverlay('title-screen');
}

function showPause() {
  game.state = 'paused';
  game.paused = true;
  showOverlay('pause-menu');
}

function hidePause() {
  game.state = 'playing';
  game.paused = false;
  hideOverlay('pause-menu');
}

function showGameOver(reason) {
  game.state = 'gameover';
  const title = el('game-over-title');
  if (title) title.textContent = reason === 'CAUGHT' ? 'CAUGHT' : 'DOWN';
  const text = el('game-over-text');
  if (text) {
    text.textContent = reason === 'CAUGHT'
      ? 'The police took Rook in. The city keeps moving.'
      : 'Rook went down. The city keeps moving.';
  }
  const stats = el('game-over-stats');
  if (stats) {
    stats.textContent = 'Cash $' + (game.player.cash || 0)
      + ' · Missions done: ' + game.completedMissions.length + ' / 12';
  }
  showOverlay('game-over-screen');
}

function setStatus(text) {
  game.statusMessage = text || '';
  const node = el('status');
  if (node) node.textContent = game.statusMessage;
}

// --- Save / load ----------------------------------------------------------------
// Payload shape is the save module's: version, savedAt, mission (the
// highest mission reached), cash, player snapshot, completedMissions,
// weapons, radioStation.

function saveStateSnapshot() {
  const p = game.player;
  return {
    mission: game.highestMission || (game.mission && game.mission.id) || null,
    cash: p.cash || 0,
    player: {
      x: p.x, y: p.y, angle: p.angle, health: p.health, cash: p.cash,
      weapon: p.weapon, ammo: Object.assign({}, p.ammo), owned: Object.assign({}, p.owned),
    },
    completedMissions: game.completedMissions.slice(),
    weapons: game.weapons && typeof game.weapons.serialize === 'function'
      ? game.weapons.serialize() : null,
    radioStation: game.radioStation,
    extra: { heat: p.heat, stars: p.stars },
  };
}

function autosaveNow() {
  if (!game.saveSlots) return false;
  try {
    const res = game.saveSlots.autosave(saveStateSnapshot());
    return !!(res && res.ok);
  } catch (e) {
    return false;
  }
}

function manualSaveNow() {
  if (!game.saveSlots) return false;
  try {
    const res = game.saveSlots.manualSave(saveStateSnapshot());
    if (res && res.ok) setStatus('Game saved to slot ' + (game.saveSlots.getActiveSlot() + 1));
    return !!(res && res.ok);
  } catch (e) {
    return false;
  }
}

function applyLoadedSave(data) {
  if (!data || typeof data !== 'object') return false;
  const p = game.player;
  if (data.player && typeof data.player === 'object') {
    if (typeof data.player.x === 'number') p.x = data.player.x;
    if (typeof data.player.y === 'number') p.y = data.player.y;
    if (typeof data.player.angle === 'number') p.angle = data.player.angle;
    if (typeof data.player.health === 'number') p.health = data.player.health;
    if (data.player.ammo) p.ammo = Object.assign({}, p.ammo, data.player.ammo);
    if (data.player.owned) p.owned = Object.assign({}, p.owned, data.player.owned);
    if (typeof data.player.weapon === 'string') p.weapon = data.player.weapon;
  }
  if (typeof data.cash === 'number') p.cash = data.cash;
  if (Array.isArray(data.completedMissions)) game.completedMissions = data.completedMissions.slice();
  if (data.mission) game.highestMission = data.mission;
  if (data.weapons && game.weapons && typeof game.weapons.restore === 'function') {
    try { game.weapons.restore(data.weapons); } catch (e) { /* keep current weapons */ }
  }
  if (typeof data.radioStation === 'string') {
    game.radioStation = data.radioStation;
    if (game.radio && typeof game.radio.setStation === 'function') {
      const idx = game.radio.stations.findIndex((s) => s.name === data.radioStation);
      if (idx >= 0) game.radio.setStation(idx);
    }
  }
  p.alive = true;
  p.health = Math.max(p.health, 1);
  if (p.car) {
    p.car.player = false;
    p.car = null;
    p.onFoot = true;
  }
  game.gameOver = null;
  game.mission = null;
  game.missionTarget = null;
  game.objectiveText = '';
  return true;
}

function loadSlot(slot) {
  if (!game.saveSlots) return false;
  let res = null;
  try { res = game.saveSlots.loadFromSlot(slot); } catch (e) { return false; }
  if (!res || !res.ok) return false;
  applyLoadedSave(res.data);
  return true;
}

function startNewGame() {
  const p = game.player;
  const spawn = (game.world && game.world.spawn) || PLAYER_SPAWN;
  p.x = spawn.x;
  p.y = spawn.y;
  p.angle = -Math.PI / 2;
  p.vx = 0;
  p.vy = 0;
  p.speed = 0;
  p.health = 100;
  p.maxHealth = 100;
  p.cash = 0;
  p.heat = 0;
  p.stars = 0;
  p.alive = true;
  p.onFoot = true;
  p.car = null;
  p.weapon = 'pistol';
  p.owned = { pistol: true, smg: false, shotgun: false };
  p.ammo = { pistol: 48, smg: 0, shotgun: 0 };
  p.hideTimer = 0;
  p.arrestTimer = 0;
  game.cars.length = 0;
  game.enemies.length = 0;
  game.bullets.length = 0;
  game.particles.length = 0;
  game.pickups.length = 0;
  policeList.length = 0;
  policeList.cops = [];
  policeList.cars = [];
  policeList.roadblocks = [];
  game.mission = null;
  game.missionTarget = null;
  game.objectiveTarget = null;
  game.objectiveText = '';
  game.completedMissions = [];
  game.highestMission = null;
  game.missionComplete = false;
  game.missionCompleteId = null;
  game.gameOver = null;
  game.time.now = 0;
  game.time.hour = 12;
  game.time.dayFraction = 0.5;
  game.hour = 12;
  game.timeOfDay = 0.5;
  game.now = 0;
  missionRuntime.active = false;
  missionRuntime.id = null;
  missionRuntime.stage = 0;
  missionRuntime.offerCooldownUntil = game.now + 5;
  missionRuntime.lastOfferedId = null;
  closeDialog();
  hideOverlay('title-screen');
  hideOverlay('pause-menu');
  hideOverlay('game-over-screen');
  game.state = 'playing';
  game.paused = false;
  if (game.radio && typeof game.radio.start === 'function') {
    try { game.radio.start(); } catch (e) { /* radio is optional */ }
  }
  if (game.audio && typeof game.audio.startMusicLoop === 'function') {
    try { game.audio.startMusicLoop(); } catch (e) { /* audio is optional */ }
  }
  if (game.audio && typeof game.audio.resume === 'function') {
    try { game.audio.resume(); } catch (e) { /* ignore */ }
  }
  // The renderer follows the player; snap it so the first frame is
  // already on Rook instead of the map corner.
  if (game.renderer && typeof game.renderer.snapToPlayer === 'function') {
    try { game.renderer.snapToPlayer(); } catch (e) { /* ignore */ }
  }
  return true;
}

function respawn() {
  const p = game.player;
  p.alive = true;
  p.health = p.maxHealth || 100;
  p.cash = Math.max(0, Math.floor((p.cash || 0) * (1 - RESPAWN_CASH_LOSS)));
  p.heat = 0;
  p.stars = 0;
  p.arrestTimer = 0;
  const spawn = (game.world && game.world.spawn) || PLAYER_SPAWN;
  p.x = spawn.x;
  p.y = spawn.y;
  if (p.car) {
    p.car.player = false;
    p.car = null;
    p.onFoot = true;
  }
  game.gameOver = null;
  hideOverlay('game-over-screen');
  game.state = 'playing';
  if (game.renderer && typeof game.renderer.snapToPlayer === 'function') {
    try { game.renderer.snapToPlayer(); } catch (e) { /* ignore */ }
  }
  // A death mid-mission restarts that mission from stage 0.
  if (missionRuntime.id) startMissionById(missionRuntime.id, { announce: false });
  return true;
}

function wireDomButtons() {
  if (typeof document === 'undefined') return;
  const on = (id, fn) => {
    const node = el(id);
    if (node) node.addEventListener('click', fn);
  };
  on('new-game-btn', () => { startNewGame(); });
  on('continue-btn', () => {
    const slots = game.saveSlots ? game.saveSlots.listSlots() : [];
    let slot = game.saveSlots ? game.saveSlots.getActiveSlot() : 0;
    if (!slots[slot] || slots[slot].status !== 'ok') {
      const ok = slots.findIndex((s) => s.status === 'ok');
      if (ok < 0) return;
      slot = ok;
    }
    if (loadSlot(slot)) {
      hideOverlay('title-screen');
      game.state = 'playing';
      game.paused = false;
      const next = nextMissionId(typeof game.highestMission === 'string' ? game.highestMission : null);
      if (next) offerMission(next);
    }
  });
  const slotList = el('save-slots');
  if (slotList) {
    slotList.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('button[data-slot]') : null;
      if (!btn) return;
      const slot = Number(btn.getAttribute('data-slot')) - 1;
      if (Number.isNaN(slot) || slot < 0 || slot > 2) return;
      if (loadSlot(slot)) {
        hideOverlay('title-screen');
        game.state = 'playing';
        game.paused = false;
      }
    });
  }
  on('resume-btn', () => { hidePause(); });
  on('save-btn', () => { manualSaveNow(); });
  on('quit-to-title-btn', () => { showTitle(); });
  on('respawn-btn', () => { respawn(); });
  on('game-over-title-btn', () => { showTitle(); });
  on('mission-accept-btn', () => { acceptDialog(); });
  on('mission-decline-btn', () => { declineDialog(); });
}

// --- Input sync + key routing -------------------------------------------------
// The loop syncs the input object's gameplay fields from the raw input
// before any update reads them, and routes the edge keys (weapons,
// radio, garage, pause) once per frame.

function syncInputFromRaw() {
  const input = game.input;
  if (!input) return;
  const camera = game.renderer ? game.renderer.camera : null;
  let aim = { x: game.player.x, y: game.player.y };
  try {
    if (typeof input.mouseWorld === 'function') aim = input.mouseWorld(camera);
    else if (typeof input.aimAngle === 'function') input.aimAngle(game.player.x, game.player.y, camera);
  } catch (e) { /* aim stays on the player */ }
  input.aimX = aim.x;
  input.aimY = aim.y;
  input.mouseWorldX = aim.x;
  input.mouseWorldY = aim.y;
  input.mouseDown = !!(input.mouse && input.mouse.down);
  input.mousePressed = !!(input.mouse && input.mouse.justPressed);
  // Edge booleans from the raw key edges (never overwrite the
  // input object's own interactPressed() method with a boolean).
  input.interactPressed = (typeof input.isPressed === 'function'
    && (input.isPressed('KeyE') || input.isPressed('Enter')));
  input.ePressed = input.interactPressed;
}

function routeEdgeKeys() {
  const input = game.input;
  if (!input || typeof input.isPressed !== 'function') return;
  if (game.state !== 'playing' || game.paused) return;
  if (game.dialog && (game.dialog.open || game.dialog.visible)) return;
  if (game.garage && game.garage.state && game.garage.state.open) return;
  const p = game.player;
  for (const code of ['Digit1', 'Digit2', 'Digit3', 'KeyQ']) {
    if (input.isPressed(code) && game.weapons && typeof game.weapons.onKey === 'function') {
      try { game.weapons.onKey(code); } catch (e) { /* weapon keys never break the frame */ }
    }
  }
  if (input.isPressed('KeyR') && game.radio && typeof game.radio.onKey === 'function') {
    try { game.radio.onKey('KeyR'); } catch (e) { /* ignore */ }
  }
  // E opens the Fixer Garage when Rook is in the car inside the zone;
  // on foot, E is the car key the player module already handles.
  if (input.isPressed('KeyE') && p && !p.onFoot && game.garage && typeof game.garage.isPlayerInZone === 'function') {
    try {
      if (game.garage.isPlayerInZone()) game.garage.open();
    } catch (e) { /* ignore */ }
  }
}

// --- Mission module update + handoff watch ------------------------------------
// The module advances its own stages when it owns the arc; this loop
// only watches for what it reports and routes every reported change
// through the single handoff path (advanceMissionStage), so a stage
// change can never arrive with a stale target or a stale car route.

const missionWatch = {
  lastId: null,
  lastStage: -1,
  noMissionSince: 0,
  noMissionOfferedAt: -1,
};

function updateMissionsModule(dt) {
  const handle = game.missionsHandle;
  let ran = false;
  if (handle && typeof handle.update === 'function') {
    try { handle.update(dt); ran = true; } catch (e) { ran = false; }
  }
  if (!ran && typeof MissionsMod.updateMissions === 'function') {
    try { MissionsMod.updateMissions(game, dt); ran = true; } catch (e) { ran = false; }
  }
  if (!ran && typeof MissionsMod.update === 'function') {
    try { MissionsMod.update(game, dt); ran = true; } catch (e) { ran = false; }
  }
  if (game.act2Handle && typeof game.act2Handle.update === 'function') {
    try { game.act2Handle.update(dt); } catch (e) { /* act2 update is best-effort */ }
  }
  return ran;
}

function watchMissionHandoff() {
  const m = game.mission;
  const id = m && m.id ? m.id : null;
  const stage = m && typeof m.stage === 'number' ? m.stage : 0;
  // Completion reported by the module: the mission object is gone but
  // the completed list grew, or the module flagged it complete.
  if (!id && missionWatch.lastId && game.completedMissions.includes(missionWatch.lastId)) {
    const doneId = missionWatch.lastId;
    missionWatch.lastId = null;
    missionWatch.lastStage = -1;
    missionRuntime.active = false;
    autosaveNow();
    const next = nextMissionId(doneId);
    if (next) offerMission(next);
    return;
  }
  if (id && (id !== missionWatch.lastId || stage !== missionWatch.lastStage)) {
    const firstSight = missionWatch.lastId !== id;
    missionWatch.lastId = id;
    missionWatch.lastStage = stage;
    // A new mission (or a new stage) reported by the module: route it
    // through the single handoff path. On a first sight the start path
    // already ran; on a stage change the advance path installs the
    // new stage's target and resets the driver.
    if (firstSight) {
      missionRuntime.active = true;
      missionRuntime.id = id;
      missionRuntime.stage = stage;
      missionRuntime.startedAt = game.now;
      game.missionStartedAt = game.now;
      game.missionComplete = false;
      game.missionCompleteId = null;
      if (game.wiring.missions === 'fallback') beginFallbackStage(id, stage);
    } else {
      advanceMissionStage(id, stage);
    }
  }
  if (!id) {
    // No mission active: after a grace period with no dialog either,
    // offer the next uncompleted mission (the module may offer on its
    // own first — this only fires when nothing arrived).
    if (!game.dialog || (!game.dialog.open && !game.dialog.visible)) {
      if (missionWatch.noMissionSince === 0) missionWatch.noMissionSince = game.now;
      const idleFor = game.now - missionWatch.noMissionSince;
      const grace = game.autopilotMode ? FIRST_MISSION_GRACE_SEC : MISSION_OFFER_GRACE_SEC;
      if (idleFor > grace && missionWatch.noMissionOfferedAt < 0) {
        const next = nextMissionId(game.highestMission) || 'm1';
        if (!game.completedMissions.includes(next)) {
          missionWatch.noMissionOfferedAt = game.now;
          offerMission(next);
        }
      }
    } else {
      missionWatch.noMissionSince = 0;
      missionWatch.noMissionOfferedAt = -1;
    }
  } else {
    missionWatch.noMissionSince = 0;
    missionWatch.noMissionOfferedAt = -1;
  }
}

// --- Debug snapshot -------------------------------------------------------------
// Plain data only, published every frame for the playtest and
// screenshot tools. Field names match the tools' whitelist.

function publishDebugSnapshot() {
  if (typeof window === 'undefined') return;
  const p = game.player;
  const m = game.mission;
  const weapon = game.weapons && typeof game.weapons.hudText === 'function'
    ? game.weapons.hudText() : { weapon: 'Pistol', ammo: p.ammo ? p.ammo[p.weapon || 'pistol'] : 0 };
  const limit = m ? (missionDef(m.id) || {}).limit || 0 : 0;
  const timeLeft = m ? Math.max(0, Math.round(limit - (game.now - game.missionStartedAt))) : 0;
  let enemiesLeft = 0;
  try {
    enemiesLeft = game.combat && typeof game.combat.enemiesAlive === 'function'
      ? game.combat.enemiesAlive() : 0;
  } catch (e) { enemiesLeft = 0; }
  window.__crescentDebug = {
    missionId: m ? m.id : null,
    missionStage: m && typeof m.stage === 'number' ? m.stage : 0,
    missionComplete: !!game.missionComplete,
    // Which mission completed — the boolean alone is sticky (it stays
    // true after m1), so a reader waiting on m2 would take m1's flag
    // as its own completion. The id makes the signal per-mission.
    missionCompleteId: game.missionCompleteId || null,
    completedMissions: game.completedMissions.slice(),
    highestMission: game.highestMission,
    cash: p.cash || 0,
    health: Math.round(p.health || 0),
    ammo: weapon.ammo,
    weapon: weapon.weapon,
    radio: game.radioStation,
    heat: Math.round(p.heat || 0),
    stars: p.stars || 0,
    night: !!game.isNight,
    timeOfDay: game.timeOfDay,
    objective: game.objectiveText || '',
    inCar: !p.onFoot,
    speed: Math.round(Math.abs(p.speed || 0)),
    x: Math.round(p.x),
    y: Math.round(p.y),
    dialogOpen: !!(game.dialog && (game.dialog.open || game.dialog.visible)),
    gameOver: game.gameOver ? game.gameOver.reason : null,
    autopilot: !!game.autopilotEnabled,
    enemiesLeft,
    timeLeft,
    wiring: game.wiring.missions + '/' + game.wiring.police + '/' + game.wiring.vehicles,
  };
}

// --- Per-frame updates ----------------------------------------------------------
// The loop is: time -> input sync -> pause toggle (first, before any
// early exit) -> missions module -> handoff watch -> autopilot (before
// the dialog branch) -> dialog branch -> edge keys -> player (every
// playing frame) -> the rest of the world -> mirrors -> render -> HUD
// -> debug snapshot -> endFrame (edge flags cleared last, never first).

let lastTimestamp = 0;
let lastSirenOn = false;
let gameOverSeenAtMs = 0;

function advanceClock(dt) {
  game.now += dt;
  game.time.now = game.now;
  game.dt = dt;
  // The day drifts slowly (one full day per ten minutes) so the light
  // changes across a long session without ever flipping mid-mission.
  let frac = game.time.dayFraction + dt / 600;
  if (frac >= 1) frac -= 1;
  game.time.dayFraction = frac;
  game.timeOfDay = frac;
  game.time.hour = frac * 24;
  game.hour = frac * 24;
  // Darkness from the clock, same bands the renderer uses: day in the
  // middle of the clock, deep night at the edges, soft dusk between.
  let dark = 0;
  if (frac >= 0.3 && frac <= 0.7) dark = 0;
  else if (frac >= 0.22 && frac < 0.3) dark = ((0.3 - frac) / 0.08) * 0.4;
  else if (frac > 0.7 && frac <= 0.78) dark = ((frac - 0.7) / 0.08) * 0.4;
  else dark = 0.85;
  game.nightFactor = dark;
  game.isNight = dark > 0.5;
}

function mirrorPlayerState() {
  const p = game.player;
  game.wanted.heat = p.heat || 0;
  game.wanted.stars = p.stars || 0;
  game.heat = p.heat || 0;
}

function syncWeaponsToPlayer() {
  const p = game.player;
  const w = game.weapons;
  if (!w || !w.state) return;
  p.weapon = w.state.current || p.weapon;
  if (w.state.ammo) p.ammo = Object.assign({}, w.state.ammo);
  if (w.state.owned) p.owned = Object.assign({}, w.state.owned);
}

function syncHelicopterFlags() {
  const heli = game.helicopter;
  if (!heli || !heli.state) return;
  heli.active = heli.state.active;
  heli.spotlightOnPlayer = heli.state.spotlightOnPlayer;
  heli.x = heli.state.x;
  heli.y = heli.state.y;
}

function syncRadioStation() {
  if (game.radio && typeof game.radio.stationName === 'function') {
    try { game.radioStation = game.radio.stationName(); } catch (e) { /* keep last station */ }
  }
}

function updateSiren() {
  if (!game.audio) return;
  const want = (game.player.stars || 0) >= 2 && game.state === 'playing';
  if (want === lastSirenOn) return;
  lastSirenOn = want;
  try {
    if (want && typeof game.audio.playSiren === 'function') game.audio.playSiren();
    else if (!want && typeof game.audio.stopSiren === 'function') game.audio.stopSiren();
  } catch (e) { /* siren is cosmetic */ }
}

function updateEngineSound() {
  if (!game.audio || typeof game.audio.setEngineLevel !== 'function') return;
  const p = game.player;
  let level = 0;
  if (!p.onFoot && p.car) {
    const top = effectiveTopSpeed(p.car) || 400;
    level = clamp(Math.abs(p.car.speed || 0) / top, 0, 1);
  }
  try { game.audio.setEngineLevel(level); } catch (e) { /* ignore */ }
}

function updatePlaying(dt) {
  advanceClock(dt);
  // The missions module advances its own stages; the watch routes
  // every change it reports through the single handoff path.
  updateMissionsModule(dt);
  watchMissionHandoff();

  // Autopilot BEFORE the dialog branch: it must be able to press E to
  // accept a mission offer (the v1 deadlock was the reverse order).
  if (game.autopilotEnabled && game.autopilot && typeof game.autopilot.update === 'function') {
    try { game.autopilot.update(dt); } catch (e) { /* a driver fault never kills the frame */ }
  }

  // Dialog branch: an open offer eats the interact edge. Accept runs
  // the single start path; while the dialog stays open the player
  // does not move or shoot, but the city behind it keeps living.
  const dialog = game.dialog;
  const dialogOpen = !!(dialog && (dialog.open || dialog.visible));
  if (dialogOpen) {
    showDialogDom();
    if (game.input.interactPressed) {
      acceptDialog();
    } else {
      updateTraffic(game, dt);
      if (game.pedestrians && typeof game.pedestrians.update === 'function') {
        try { game.pedestrians.update(dt); } catch (e) { /* ignore */ }
      }
      updatePolice(dt);
      if (game.helicopter && typeof game.helicopter.update === 'function') {
        try { game.helicopter.update(dt); } catch (e) { /* ignore */ }
      }
      syncHelicopterFlags();
      mirrorPlayerState();
      return;
    }
  }

  routeEdgeKeys();

  // The player update runs on EVERY playing frame. One dropped call
  // once froze Rook solid; the smoke test proves movement every run.
  // (game.autopilotDrove is owned by the autopilot: it sets the flag
  // when it drives the car, and player.js skips manual driving on
  // those frames. Nothing here may clear it after the autopilot ran.)
  updatePlayer(game, dt);
  if (game.state === 'gameover' || (game.gameOver && game.gameOver.reason)) {
    showGameOver(game.gameOver.reason || 'DOWN');
    return;
  }
  mirrorPlayerState();

  if (game.weapons && typeof game.weapons.update === 'function') {
    try { game.weapons.update(dt); } catch (e) { /* ignore */ }
  }
  syncWeaponsToPlayer();
  if (game.combat && typeof game.combat.update === 'function') {
    try { game.combat.update(dt); } catch (e) { /* ignore */ }
  }
  // Death can land inside combat.update (an enemy bullet), after the
  // game-over check above already passed this frame. Show the overlay
  // now instead of leaving the next frame to discover a frozen state.
  if (game.state === 'gameover' || (game.gameOver && game.gameOver.reason)) {
    showGameOver(game.gameOver.reason || 'DOWN');
    return;
  }
  updateTraffic(game, dt);
  if (game.pedestrians && typeof game.pedestrians.update === 'function') {
    try { game.pedestrians.update(dt); } catch (e) { /* ignore */ }
  }
  updatePolice(dt);
  if (game.helicopter && typeof game.helicopter.update === 'function') {
    try { game.helicopter.update(dt); } catch (e) { /* ignore */ }
  }
  syncHelicopterFlags();
  if (game.garage && typeof game.garage.update === 'function') {
    try { game.garage.update(dt); } catch (e) { /* ignore */ }
  }
  if (game.radio && typeof game.radio.update === 'function') {
    try { game.radio.update(dt); } catch (e) { /* ignore */ }
  }
  syncRadioStation();
  if (game.livingCity && typeof game.livingCity.update === 'function') {
    try { game.livingCity.update(dt); } catch (e) { /* ignore */ }
  }
  if (game.wiring.missions === 'fallback') updateFallbackMission(dt);
  updateShotPose(dt);
  updateSiren();
  updateEngineSound();
  if (game.hud && typeof game.hud.syncOverlays === 'function') {
    try { game.hud.syncOverlays(); } catch (e) { /* overlays are DOM-only */ }
  }
}

function renderFrame(dt) {
  if (!canvas || !game.renderer) return;
  try {
    game.renderer.render(dt);
  } catch (e) {
    return;
  }
  if (game.state === 'playing' || game.state === 'paused' || game.state === 'gameover') {
    const ctx = canvas.getContext('2d');
    if (ctx && game.hud && typeof game.hud.draw === 'function') {
      try { game.hud.draw(ctx); } catch (e) { /* HUD never breaks the frame */ }
    }
  }
}

function frame(timestamp) {
  const now = typeof timestamp === 'number' ? timestamp : 0;
  let dt = lastTimestamp ? (now - lastTimestamp) / 1000 : FRAME_DT;
  lastTimestamp = now;
  if (!Number.isFinite(dt) || dt <= 0) dt = FRAME_DT;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

  syncInputFromRaw();

  // The game-over timer only runs while the game-over state lasts.
  if (game.state !== 'gameover') gameOverSeenAtMs = 0;

  // Pause first, before any state early-exit: a paused game must
  // always be unpausable, and the garage menu closes on Esc too.
  if (game.input.pausePressed()) {
    if (game.garage && game.garage.state && game.garage.state.open) {
      try { game.garage.close(); } catch (e) { /* ignore */ }
    } else if (game.state === 'playing') {
      showPause();
    } else if (game.state === 'paused') {
      hidePause();
    }
  }

  if (game.state === 'playing' && !game.paused) {
    updatePlaying(dt);
  } else if (game.state === 'title') {
    // The living city runs behind the title overlay.
    advanceClock(dt);
    updateTraffic(game, dt);
    if (game.pedestrians && typeof game.pedestrians.update === 'function') {
      try { game.pedestrians.update(dt); } catch (e) { /* ignore */ }
    }
    updateShotPose(dt);
  } else if (game.state === 'gameover') {
    // A death that lands mid-frame (an enemy bullet via combat.update)
    // used to freeze here forever: updatePlaying() never ran again,
    // so showGameOver() was never called, the overlay never appeared
    // and no respawn button existed. Show the overlay from the frame
    // loop itself — the one choke point every death passes through.
    // While the autopilot drives, take the respawn for it after a
    // short beat so a failed mission restarts from stage 0 instead of
    // waiting on a human click; a human player still clicks the
    // button herself.
    if (game.gameOver) showGameOver(game.gameOver.reason || 'DOWN');
    if (game.autopilotEnabled) {
      if (!gameOverSeenAtMs) gameOverSeenAtMs = Date.now();
      else if (Date.now() - gameOverSeenAtMs > 1500) {
        gameOverSeenAtMs = 0;
        respawn();
      }
    }
  }
  // 'paused' updates nothing at all.

  renderFrame(dt);
  publishDebugSnapshot();
  if (game.input && typeof game.input.endFrame === 'function') game.input.endFrame();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
}

// --- Boot ------------------------------------------------------------------------
// Build order matters: the adapters first (they may register the act2
// arc), then the arc table, then the DOM, then the shot pose or the
// autopilot flag, then the title screen and the loop.

function resizeCanvas() {
  if (!canvas || !game.renderer) return;
  const w = canvas.clientWidth || 1280;
  const h = canvas.clientHeight || 800;
  try { game.renderer.resize(w, h, 1); } catch (e) { /* resize is best-effort */ }
}

function boot() {
  buildMissionsHandle();
  buildPoliceHandle();
  buildAct2Handle();
  buildVehiclesHandle();
  rebuildMissionArc();

  // Default police hooks (the shots module calls them when a pose
  // needs a chase or a roadblock); setupShotPose replaces them with
  // pose-aware versions when a shot is requested.
  if (typeof game.spawnPoliceChase !== 'function') {
    game.spawnPoliceChase = function spawnPoliceChase(n) {
      const p = game.player;
      const count = n || 3;
      for (let i = 0; i < count; i++) {
        const car = spawnCar('police', p.x, p.y + 130 + i * 120, {
          driver: 'police', cruise: 520, angle: -Math.PI / 2,
        });
        car.isPolice = true;
        policeList.cars.push(car);
      }
      return true;
    };
  }
  if (typeof game.spawnRoadblock !== 'function') {
    game.spawnRoadblock = function spawnRoadblock(x, y) {
      policeList.roadblocks.push({ x, y, angle: 0 });
      game.roadblocks = policeList.roadblocks;
      return true;
    };
  }

  wireDomButtons();
  resizeCanvas();
  if (game.renderer && typeof game.renderer.snapToPlayer === 'function') {
    try { game.renderer.snapToPlayer(); } catch (e) { /* ignore */ }
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', resizeCanvas);
  }

  const shotActive = setupShotPose();

  if (query.autopilot) {
    // Autopilot mode (playtest): skip the title screen entirely and
    // start playing at once, with the requested mission engaged.
    game.autopilotEnabled = true;
    game.autopilotMode = query.autopilot;
    if (game.autopilot && typeof game.autopilot.enable === 'function') {
      try { game.autopilot.enable(); } catch (e) { /* ignore */ }
    }
    startNewGame();
    const wanted = query.autopilot;
    if (/^m([1-9]|1[0-2])$/.test(wanted)) {
      // Single-mission filter: mark the earlier missions done so the
      // harness sees a clean prerequisite chain, then start this one.
      const idx = MISSION_ORDER.indexOf(wanted);
      for (let i = 0; i < idx; i++) {
        if (!game.completedMissions.includes(MISSION_ORDER[i])) {
          game.completedMissions.push(MISSION_ORDER[i]);
        }
      }
      if (idx > 0) game.highestMission = MISSION_ORDER[idx - 1];
      startMissionById(wanted);
    } else {
      // 'arc': the whole chain, starting at m1.
      startMissionById('m1');
    }
  } else if (shotActive) {
    // A screenshot pose drives its own state (title for 'start',
    // playing for the rest); nothing else to start.
    if (query.shot === 'start') showTitle();
  } else {
    showTitle();
  }

  publishDebugSnapshot();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(frame);
  }
  return game;
}

export { game, startMissionById, advanceMissionStage, completeMission, offerMission, acceptDialog, startNewGame, respawn, boot };

boot();

// Crescent Bay — the eight-mission story arc.
//
// Rook works for two fixers, Mara and Dex. The campaign is linear:
// finish one job and the next one opens. Every mission is a condition
// to satisfy ("reach the marker", "escape the police"), never a kill
// count, and a failed mission restarts from its own stage 0, never
// from the start of the campaign. Between missions Rook is free to
// roam the city.
//
// This file owns the arc data, the mission state machine, the
// dialogue offer, the objective banner text and the map marker. It
// calls into police.js for the wanted cover on the highway job, into
// vehicles.js for the courier car on the tail chase, and into the
// combat system (through the context handed in by the main loop) for
// the finale shootout. It never touches the renderer or the HUD
// directly — those read the state exported here.

import {
  MARKET,
  CLUB,
  MARINA,
  AIRPORT,
  HIDEOUT,
  FIXER_GARAGE,
  SPRAY_SHOP,
  BANK,
  MISSION_REWARDS,
  PLAYER_START,
} from './config.js';
import { setWantedHeat } from './police.js';
import {
  createCar,
  updateCar,
  findRoute,
  nearestRoadPoint,
  setCarRoute,
  routeNeedsRebuild,
  distanceBetween,
} from './vehicles.js';

const MISSION_ARC = [
  {
    id: 'm1',
    name: 'First Job',
    fixer: 'Mara',
    hook: 'Mara: Rook, first job. Pick up the package at the market and drop it downtown. Easy money — do not make it complicated.',
    reward: MISSION_REWARDS.m1,
    timeLimit: 300,
    type: 'drive',
    stages: [
      { kind: 'pickup', label: 'Pick up the package at the Market', x: MARKET.x, y: MARKET.y },
      { kind: 'deliver', label: 'Deliver the package downtown', x: 2200, y: 1000 },
    ],
  },
  {
    id: 'm2',
    name: 'Tail Chase',
    fixer: 'Mara',
    hook: 'Mara: A courier is carrying something that belongs to us. Ram his car four times and he will hand it over. Do not let him outrun you.',
    reward: MISSION_REWARDS.m2,
    timeLimit: 300,
    type: 'chase',
    stages: [
      { kind: 'chase', label: 'Ram the courier car 4 times', x: 1800, y: 1400, hitsNeeded: 4 },
    ],
  },
  {
    id: 'm3',
    name: 'Hot Wheels',
    fixer: 'Dex',
    hook: 'Dex: Three checkpoints, one fast car, no excuses. Club, marina, airport — beat the clock and the money is yours.',
    reward: MISSION_REWARDS.m3,
    timeLimit: 240,
    type: 'checkpoints',
    stages: [
      { kind: 'checkpoint', label: 'Reach the Club checkpoint', x: CLUB.x, y: CLUB.y },
      { kind: 'checkpoint', label: 'Reach the Marina checkpoint', x: MARINA.x, y: MARINA.y },
      { kind: 'checkpoint', label: 'Reach the Airport checkpoint', x: AIRPORT.x, y: AIRPORT.y },
    ],
  },
  {
    id: 'm4',
    name: 'Dockside',
    fixer: 'Mara',
    hook: 'Mara: A crate is waiting at the marina. Bring it back to the hideout. The docks are hot tonight, so keep your head down.',
    reward: MISSION_REWARDS.m4,
    timeLimit: 360,
    type: 'drive',
    stages: [
      { kind: 'pickup', label: 'Pick up the crate at the Marina', x: MARINA.x, y: MARINA.y },
      { kind: 'deliver', label: 'Deliver the crate to the Hideout', x: HIDEOUT.x, y: HIDEOUT.y },
    ],
  },
  {
    id: 'm5',
    name: 'Midnight Run',
    fixer: 'Dex',
    hook: 'Dex: Night run. Pick up at the club, drop at the docks. Keep the headlights on and do not stop for anyone.',
    reward: MISSION_REWARDS.m5,
    timeLimit: 300,
    type: 'drive',
    night: true,
    stages: [
      { kind: 'pickup', label: 'Pick up at the Club', x: CLUB.x, y: CLUB.y },
      { kind: 'deliver', label: 'Drop at the Docks', x: MARINA.x, y: MARINA.y },
    ],
  },
  {
    id: 'm6',
    name: 'Collector',
    fixer: 'Mara',
    hook: 'Mara: Five money drops are scattered around the city. Collect them all, then come home. Nobody said it would be quick.',
    reward: MISSION_REWARDS.m6,
    timeLimit: 420,
    type: 'collect',
    stages: [
      { kind: 'collect', label: 'Collect money drop 1 of 5', x: 1000, y: 1400 },
      { kind: 'collect', label: 'Collect money drop 2 of 5', x: 1800, y: 600 },
      { kind: 'collect', label: 'Collect money drop 3 of 5', x: 2600, y: 1800 },
      { kind: 'collect', label: 'Collect money drop 4 of 5', x: 600, y: 2200 },
      { kind: 'collect', label: 'Collect money drop 5 of 5', x: 2200, y: 2600 },
      { kind: 'return', label: 'Return to the Hideout', x: HIDEOUT.x, y: HIDEOUT.y },
    ],
  },
  {
    id: 'm7',
    name: 'Highway Heat',
    fixer: 'Dex',
    hook: 'Dex: Drive to the airport with the whole city on your tail, then lose them. Three stars from the moment you start — good luck, Rook.',
    reward: MISSION_REWARDS.m7,
    timeLimit: 420,
    type: 'escape',
    stages: [
      { kind: 'drive', label: 'Drive to the Airport', x: AIRPORT.x, y: AIRPORT.y },
      { kind: 'escape', label: 'Escape the police — lose the heat', x: SPRAY_SHOP.x, y: SPRAY_SHOP.y },
    ],
  },
  {
    id: 'm8',
    name: 'Crescent Job',
    fixer: 'Mara',
    hook: 'Mara: The big one. Three of them guard the bank. Take them down, then get out of there. This is the job that makes us.',
    reward: MISSION_REWARDS.m8,
    timeLimit: 600,
    type: 'shootout',
    stages: [
      { kind: 'shootout', label: 'Clear the bank — take down the guards', x: BANK.x, y: BANK.y, enemies: 3 },
      { kind: 'escape', label: 'Escape to the Hideout', x: HIDEOUT.x, y: HIDEOUT.y },
    ],
  },
];

function startMission(id, ctx) {
  const def = missionById(id);
  if (!def) return null;
  const context = ctx || missionContext;
  // Starting a mission clears any open offer dialog first, so the
  // accept key press is never swallowed by a stale dialog.
  missionState.dialog = null;
  missionState.dialogOpen = false;
  missionState.active = def;
  missionState.missionId = def.id;
  missionState.stageIndex = 0;
  missionState.stage = def.stages[0];
  missionState.timeLeft = def.timeLimit;
  missionState.timeElapsed = 0;
  missionState.objective = def.stages[0].label;
  missionState.marker = { x: def.stages[0].x, y: def.stages[0].y, label: def.stages[0].label };
  missionState.status = 'active';
  missionState.ramHits = 0;
  missionState.lastRamAt = -10;
  missionState.courier = null;
  missionState.courierTarget = null;
  missionState.enemiesSpawned = false;
  missionState.pickups = buildArenaPickups(def);
  missionState.failedReason = null;
  missionState.night = !!def.night;

  if (context) {
    if (def.night && typeof context.setNight === 'function') context.setNight(true);
    if (def.id === 'm2') spawnCourier(context);
    if (def.id === 'm8') spawnFinaleEnemies(context);
    // Mission-start heat goes in first (stealing, shooting, the job
    // itself). The wanted cover for the highway job is set AFTER
    // the mission starts, so it lands at exactly 3 stars (heat 58)
    // instead of stacking on top of the start heat.
    if (typeof context.addMissionHeat === 'function') context.addMissionHeat(def.id);
    if (def.id === 'm7' && context.wanted) setWantedHeat(context.wanted, 58);
  }
  return missionState.active;
}

// --- Shared mission state -------------------------------------------
// One live mission at a time. The HUD, minimap, autopilot and main
// loop all read this object; they never keep their own copy.

const TRIGGER_RADIUS = 50;
const ARRIVAL_RADIUS = 60;
const SPAWN_COOLDOWN_SECONDS = 5;
const RAM_HIT_RADIUS = 70;
const RAM_MIN_SPEED = 120;
const RAM_COOLDOWN_SECONDS = 1;
const COURIER_CRUISE = 380;
const COURIER_HIT_SLOWDOWN = 0.55;
const CHASE_CRUISE = 520;
const SHOOTOUT_RANGE = 320;
const ARENA_RADIUS = 340;

let missionContext = null;
const completedMissions = new Set();
let spawnCooldownLeft = SPAWN_COOLDOWN_SECONDS;

const missionState = {
  active: null,
  missionId: null,
  stageIndex: 0,
  stage: null,
  timeLeft: 0,
  timeElapsed: 0,
  objective: 'Free roam — head to the Fixer Garage for work.',
  marker: null,
  status: 'idle',
  dialog: null,
  dialogOpen: false,
  ramHits: 0,
  lastRamAt: -10,
  courier: null,
  courierTarget: null,
  enemiesSpawned: false,
  pickups: [],
  failedReason: null,
  night: false,
};

export function attachMissionContext(ctx) {
  missionContext = ctx || null;
  return missionContext;
}

export function getMissionContext() {
  return missionContext;
}

export function missionById(id) {
  for (const m of MISSION_ARC) if (m.id === id) return m;
  return null;
}

export function getNextMissionId() {
  for (const m of MISSION_ARC) {
    if (!completedMissions.has(m.id)) return m.id;
  }
  return null;
}

export function isMissionComplete(id) {
  return completedMissions.has(id);
}

export function getCompletedMissions() {
  return [...completedMissions];
}

export function getMissionProgress() {
  return { completed: completedMissions.size, total: MISSION_ARC.length, next: getNextMissionId() };
}

export function resetMissions() {
  completedMissions.clear();
  missionState.active = null;
  missionState.missionId = null;
  missionState.stageIndex = 0;
  missionState.stage = null;
  missionState.timeLeft = 0;
  missionState.timeElapsed = 0;
  missionState.objective = 'Free roam — head to the Fixer Garage for work.';
  missionState.marker = null;
  missionState.status = 'idle';
  missionState.dialog = null;
  missionState.dialogOpen = false;
  missionState.ramHits = 0;
  missionState.courier = null;
  missionState.courierTarget = null;
  missionState.enemiesSpawned = false;
  missionState.pickups = [];
  missionState.failedReason = null;
  missionState.night = false;
  spawnCooldownLeft = SPAWN_COOLDOWN_SECONDS;
}

// --- Dialogue offer --------------------------------------------------
// A mission is offered when Rook stands within 50 units of the
// Fixer Garage (the mission-giver location). The offer opens a
// dialogue box; it is accepted ONLY with E, Enter, or the on-screen
// Accept button — never by a canvas click — so the first interact
// key press is never swallowed. After spawning at the hideout there
// is a 5 second cooldown with no mission offer.

export function offerMissionAtGarage(player, dt) {
  if (dt > 0) spawnCooldownLeft = Math.max(0, spawnCooldownLeft - dt);
  if (missionState.active || missionState.dialogOpen) return null;
  if (spawnCooldownLeft > 0) return null;
  if (!player) return null;
  const nextId = getNextMissionId();
  if (!nextId) return null;
  const def = missionById(nextId);
  const d = distanceBetween(player, FIXER_GARAGE);
  if (d > TRIGGER_RADIUS) return null;
  missionState.dialog = { missionId: def.id, fixer: def.fixer, hook: def.hook, reward: def.reward };
  missionState.dialogOpen = true;
  return missionState.dialog;
}

export function acceptMissionDialog(ctx) {
  if (!missionState.dialogOpen || !missionState.dialog) return null;
  const id = missionState.dialog.missionId;
  return startMission(id, ctx || missionContext);
}

export function declineMissionDialog() {
  missionState.dialog = null;
  missionState.dialogOpen = false;
  spawnCooldownLeft = 2;
  return null;
}

export function isDialogOpen() {
  return missionState.dialogOpen;
}

export function getDialog() {
  return missionState.dialog;
}

export function notifySpawned() {
  spawnCooldownLeft = SPAWN_COOLDOWN_SECONDS;
}

// --- Markers, objectives, HUD reads ----------------------------------

export function getMissionMarker() {
  if (!missionState.active || !missionState.marker) return null;
  return { x: missionState.marker.x, y: missionState.marker.y, label: missionState.marker.label };
}

export function getMarkerForMinimap() {
  return getMissionMarker();
}

export function getObjectiveText() {
  return missionState.objective;
}

export function getCurrentMission() {
  return missionState.active;
}

export function getMissionState() {
  return missionState;
}

export function getStage() {
  return missionState.stage;
}

export function isMissionActive() {
  return !!missionState.active && missionState.status === 'active';
}

// --- Arena pickups (finale survivability) ----------------------------
// The shootout arena holds cover, health pickups and ammo pickups.
// The autopilot grabs arena ammo when its ammo is 6 or less. These
// are data only — the renderer draws them, combat consumes them.

function buildArenaPickups(def) {
  if (def.id !== 'm8') return [];
  const cx = BANK.x;
  const cy = BANK.y;
  return [
    { kind: 'health', x: cx - 180, y: cy - 140, taken: false },
    { kind: 'health', x: cx + 180, y: cy + 140, taken: false },
    { kind: 'health', x: cx, y: cy + 200, taken: false },
    { kind: 'ammo', x: cx - 140, y: cy + 160, taken: false },
    { kind: 'ammo', x: cx + 160, y: cy - 160, taken: false },
    { kind: 'ammo', x: cx + 200, y: cy + 40, taken: false },
  ];
}

export function getArenaPickups() {
  return missionState.pickups;
}

export function consumePickup(pickup) {
  if (!pickup || pickup.taken) return false;
  pickup.taken = true;
  return true;
}

export function nearestArenaPickup(player, kind, maxAmmo) {
  if (!player) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of missionState.pickups) {
    if (p.taken) continue;
    if (kind && p.kind !== kind) continue;
    if (p.kind === 'ammo' && maxAmmo != null && maxAmmo > 6) continue;
    const d = distanceBetween(player, p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

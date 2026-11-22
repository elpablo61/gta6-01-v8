// Crescent Bay — Act 2 missions (m9–m12).
//
// The second half of the twelve-mission arc, played after m8 in the
// same linear order. Each mission is a fixer job with a spoken hook,
// a cash reward, a generous clock, and objectives stated as
// conditions ("reach the hideout", "clear the arena") rather than
// kill counts. A failed mission restarts from its stage 0 — never
// from the start of the campaign.
//
// This module owns its own mission state on the host game object
// (`game.act2`) and its own arena actors (enemies, weapon crates,
// health pickups) so it does not depend on a combat module that may
// or may not exist yet. The helicopter itself lives in the
// helicopter module when one is wired in; this file only tracks how
// much damage Rook has done to it and whether it is retreating, and
// reports whether the spotlight is on Rook so the main loop can
// feed that into the wanted-heat update.
//
// HOST CONTRACT — fields this module reads or writes on `game`:
//   game.player        { x, y, health, maxHealth, onFoot, inCar,
//                        car, weapon, weapons } — the player.
//   game.wanted        { heat, stars } — the wanted meter.
//   game.cash          number — Rook's cash; rewards are added here.
//   game.completedMissions  array of mission ids already finished.
//   game.helicopter    optional { hp, retreating, retreatLeft,
//                        active } — the live helicopter, if the
//                        helicopter module manages one. When absent,
//                        this module tracks the same numbers in
//                        game.act2.heli instead.
//   game.time          optional seconds elapsed, for logging only.
// Optional host hooks, called when present and ignored when absent:
//   game.showMissionDialog(mission) — show the fixer's hook.
//   game.showObjective(text)       — update the objective banner.
//   game.damagePlayer(amount, source)
//   game.giveWeapon(kind)          — hand Rook a picked-up weapon.
//   game.onMissionComplete(mission) / game.onMissionFailed(mission, reason)
//   game.autosave()                — called after a mission completes.

import {
  MISSION_REWARDS,
  FIXER_GARAGE,
  BANK,
  AIRPORT,
  HIDEOUT,
  MARINA,
  CLUB,
} from './config.js';
import { setWantedHeat } from './police.js';
import { distanceBetween, nearestJunction } from './vehicles.js';

// ---------------------------------------------------------------------------
// Mission definitions
// ---------------------------------------------------------------------------

// The Act 2 arc. First declaration on purpose: the outline shows it.
const ACT2_MISSIONS = [
  {
    id: 'm9',
    name: 'Sky Watch',
    fixer: 'Dex',
    hook: 'Dex: "The eye in the sky is up, Rook. Three stars and a chopper on your tail. Don\'t hide — it can see you. Just drive, and get to the hideout."',
    reward: MISSION_REWARDS.m9,
    timeLimit: 420,
    type: 'escape',
    stages: [
      {
        id: 'reach-hideout',
        label: 'Reach the hideout while the helicopter is overhead',
        hint: 'Keep moving — the spotlight blocks heat decay, so hiding does not work under it.',
      },
    ],
  },
  {
    id: 'm10',
    name: 'Full Auto',
    fixer: 'Mara',
    hook: 'Mara: "Five of them holding the docks, Rook. There are crates in the arena — grab something heavier than that pistol, clear them out, then walk to the exit."',
    reward: MISSION_REWARDS.m10,
    timeLimit: 420,
    type: 'shootout',
    stages: [
      {
        id: 'arm-up',
        label: 'Pick up a better weapon from the crates',
        hint: 'An SMG crate and a shotgun crate are waiting in the arena.',
      },
      {
        id: 'clear-arena',
        label: 'Clear the dockside arena',
        hint: 'Five enemies. Use the crates and the ammo nearby.',
      },
      {
        id: 'reach-exit',
        label: 'Reach the exit marker',
        hint: 'Arena clear — walk to the exit.',
      },
    ],
  },
  {
    id: 'm11',
    name: 'Tune-Up',
    fixer: 'Dex',
    hook: 'Dex: "My garage, your car, my prices. Buy at least one upgrade — any one — then run three drops across the city in the tuned car. No purchase, no payday."',
    reward: MISSION_REWARDS.m11,
    timeLimit: 420,
    type: 'garage-delivery',
    stages: [
      {
        id: 'garage',
        label: 'Drive to the Fixer Garage and buy an upgrade',
        hint: 'Drive into the garage zone and press E to open the menu.',
      },
      {
        id: 'delivery-1',
        label: 'Deliver to the Club',
        hint: 'Checkpoint 1 of 3 — in the upgraded car.',
      },
      {
        id: 'delivery-2',
        label: 'Deliver to the Marina',
        hint: 'Checkpoint 2 of 3 — in the upgraded car.',
      },
      {
        id: 'delivery-3',
        label: 'Deliver to the Airport',
        hint: 'Checkpoint 3 of 3 — in the upgraded car.',
      },
    ],
  },
  {
    id: 'm12',
    name: 'Bay Finale',
    fixer: 'Mara',
    hook: 'Mara: "This is the one, Rook. The bank, four guards, a chopper at four stars. Grab the loot, then run for the plane at the airport. Biggest score in the city — don\'t get caught."',
    reward: MISSION_REWARDS.m12,
    timeLimit: 600,
    type: 'finale',
    stages: [
      {
        id: 'bank-shootout',
        label: 'Clear the bank shootout',
        hint: 'Four enemies plus the helicopter overhead. Use the cover and the health pickups.',
      },
      {
        id: 'grab-loot',
        label: 'Grab the loot at the bank',
        hint: 'Walk to the bank marker and take it.',
      },
      {
        id: 'escape-airport',
        label: 'Escape to the airport',
        hint: 'The helicopter and the roadblocks are coming with you.',
      },
      {
        id: 'reach-plane',
        label: 'Reach the plane',
        hint: 'Board the plane and the score is yours.',
      },
    ],
  },
];

const ACT2_MISSION_IDS = ACT2_MISSIONS.map((m) => m.id);

// Fixed arena points. The m10 arena sits on the docks by the marina;
// the m12 shootout sits at the bank. The plane waits at the airport,
// a short drive east of the terminal marker.
const M10_ARENA = { x: MARINA.x, y: MARINA.y };
const M10_EXIT = { x: 2600, y: 3000 };
const M12_PLANE = { x: 2850, y: 300 };
const M11_CHECKPOINTS = [CLUB, MARINA, AIRPORT];

const ENEMY_HP = 36;
const ENEMY_FIRE_RANGE = 340;
const ENEMY_FIRE_INTERVAL = 1.9;
const ENEMY_HIT_DAMAGE = 5;
const ENEMY_HIT_CHANCE = 0.55;
const HELICOPTER_HP = 100;
const HELICOPTER_RETREAT_SECONDS = 20;
const MARKER_RADIUS = 80;
const LOOT_RADIUS = 70;
const CRATE_RADIUS = 44;
const PICKUP_RADIUS = 44;
const HEALTH_PICKUP_AMOUNT = 40;

export {
  ACT2_MISSIONS,
  ACT2_MISSION_IDS,
  M10_ARENA,
  M10_EXIT,
  M12_PLANE,
  M11_CHECKPOINTS,
};

export function act2MissionById(id) {
  for (const m of ACT2_MISSIONS) {
    if (m.id === id) return m;
  }
  return null;
}

export function act2IsAct2(id) {
  return ACT2_MISSION_IDS.indexOf(id) !== -1;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function createAct2State(mission) {
  return {
    missionId: mission.id,
    stageIndex: 0,
    timeLeft: mission.timeLimit,
    failed: false,
    completed: false,
    failReason: null,
    // Where Rook stood when the mission began; a failed mission
    // restarts from stage 0 back at this spot.
    startX: 0,
    startY: 0,
    // Arena actors, filled in by the mission setup below.
    enemies: [],
    crates: [],
    pickups: [],
    // m10: true once Rook has picked up an SMG or shotgun.
    armed: false,
    // m11: true once a garage purchase lands; the id of the car
    // that was upgraded, so the delivery must use that car.
    boughtUpgrade: false,
    upgradedCarId: null,
    checkpointsHit: 0,
    // m12: true once the loot marker has been grabbed.
    lootGrabbed: false,
    // Helicopter damage tracking (used when no helicopter module
    // owns the live object; mirrored onto game.helicopter when one
    // exists).
    heli: {
      hp: HELICOPTER_HP,
      retreating: false,
      retreatLeft: 0,
      active: false,
    },
  };
}

// Snap a ring of points around a centre onto the nearest junctions,
// so finale enemies always spawn on roads, never inside buildings.
function ringPointsOnRoads(center, count, radius) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + 0.35;
    const px = center.x + Math.cos(angle) * radius;
    const py = center.y + Math.sin(angle) * radius;
    const j = nearestJunction(px, py);
    points.push({ x: j.x, y: j.y });
  }
  return points;
}

function makeEnemy(id, x, y, index) {
  return {
    id,
    x,
    y,
    hp: ENEMY_HP,
    maxHp: ENEMY_HP,
    alive: true,
    weapon: 'pistol',
    // Staggered first shots so all five do not fire at once.
    fireCooldown: 0.8 + index * 0.5,
  };
}

function makeCrate(kind, x, y) {
  return { kind, x, y, taken: false };
}

function makeHealthPickup(x, y) {
  return { kind: 'health', x, y, taken: false, amount: HEALTH_PICKUP_AMOUNT };
}

// ---------------------------------------------------------------------------
// Starting a mission
// ---------------------------------------------------------------------------

// StartMission-style entry for Act 2. Sets the wanted cover level
// AFTER the mission has started, so mission-start heat never stacks
// on top of the cover by accident.
export function startAct2Mission(game, id) {
  const mission = act2MissionById(id);
  if (!mission) return null;
  const player = game.player || {};
  const state = createAct2State(mission);
  state.startX = player.x || 0;
  state.startY = player.y || 0;
  game.act2 = state;
  game.currentMission = mission;
  game.currentMissionId = mission.id;
  game.missionStage = 0;

  if (mission.id === 'm9') {
    // Three stars from the first second, helicopter overhead.
    if (game.wanted) setWantedHeat(game.wanted, 58);
    state.heli.active = true;
  }

  if (mission.id === 'm10') {
    const spots = ringPointsOnRoads(M10_ARENA, 5, 200);
    state.enemies = spots.map((p, i) => makeEnemy('m10-e' + (i + 1), p.x, p.y, i));
    state.crates = [
      makeCrate('smg', M10_ARENA.x - 90, M10_ARENA.y - 60),
      makeCrate('shotgun', M10_ARENA.x + 90, M10_ARENA.y + 60),
      makeCrate('ammo', M10_ARENA.x, M10_ARENA.y + 120),
    ];
    state.pickups = [makeHealthPickup(M10_ARENA.x - 140, M10_ARENA.y + 40)];
  }

  if (mission.id === 'm11') {
    state.checkpointsHit = 0;
  }

  if (mission.id === 'm12') {
    // Four stars from the first second, helicopter overhead.
    if (game.wanted) setWantedHeat(game.wanted, 74);
    state.heli.active = true;
    const spots = ringPointsOnRoads(BANK, 4, 190);
    state.enemies = spots.map((p, i) => makeEnemy('m12-e' + (i + 1), p.x, p.y, i));
    // Cover + health in the shootout area, so the finale is
    // survivable. Cover spots are data for the renderer/autopilot.
    state.coverSpots = [
      { x: BANK.x - 120, y: BANK.y - 90 },
      { x: BANK.x + 120, y: BANK.y - 90 },
      { x: BANK.x - 120, y: BANK.y + 110 },
      { x: BANK.x + 120, y: BANK.y + 110 },
    ];
    state.pickups = [
      makeHealthPickup(BANK.x - 160, BANK.y + 30),
      makeHealthPickup(BANK.x + 160, BANK.y - 30),
      makeHealthPickup(BANK.x, BANK.y + 170),
    ];
  }

  if (game.showMissionDialog) game.showMissionDialog(mission);
  if (game.showObjective) game.showObjective(act2ObjectiveText(game));
  return mission;
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

export function act2CurrentStage(game) {
  const state = game.act2;
  if (!state) return null;
  const mission = act2MissionById(state.missionId);
  if (!mission) return null;
  return mission.stages[state.stageIndex] || null;
}

export function act2ObjectiveText(game) {
  const state = game.act2;
  if (!state) return '';
  const mission = act2MissionById(state.missionId);
  const stage = act2CurrentStage(game);
  if (!mission || !stage) return '';
  return mission.name + ' — ' + stage.label;
}

function advanceStage(game) {
  const state = game.act2;
  if (!state) return;
  state.stageIndex += 1;
  game.missionStage = state.stageIndex;
  if (game.showObjective) game.showObjective(act2ObjectiveText(game));
}

function playerPosition(game) {
  const p = game.player || {};
  return { x: p.x || 0, y: p.y || 0 };
}

function aliveEnemies(state) {
  return state.enemies.filter((e) => e.alive);
}

function nearestAliveEnemy(state, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const d = distanceBetween({ x, y }, e);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

// The point the autopilot (and the minimap marker) should aim at
// right now. Always a real place in the world, never a moving
// target the driver cannot catch.
export function act2CurrentTarget(game) {
  const state = game.act2;
  if (!state) return null;
  const stage = act2CurrentStage(game);
  if (!stage) return null;
  const pos = playerPosition(game);

  if (state.missionId === 'm9') {
    return { x: HIDEOUT.x, y: HIDEOUT.y, label: stage.label };
  }
  if (state.missionId === 'm10') {
    if (stage.id === 'arm-up') {
      for (const c of state.crates) {
        if (!c.taken && (c.kind === 'smg' || c.kind === 'shotgun')) {
          return { x: c.x, y: c.y, label: stage.label };
        }
      }
      return { x: M10_ARENA.x, y: M10_ARENA.y, label: stage.label };
    }
    if (stage.id === 'clear-arena') {
      const e = nearestAliveEnemy(state, pos.x, pos.y);
      if (e) return { x: e.x, y: e.y, label: stage.label };
      return { x: M10_ARENA.x, y: M10_ARENA.y, label: stage.label };
    }
    return { x: M10_EXIT.x, y: M10_EXIT.y, label: stage.label };
  }
  if (state.missionId === 'm11') {
    if (stage.id === 'garage') {
      return { x: FIXER_GARAGE.x, y: FIXER_GARAGE.y, label: stage.label };
    }
    const cp = M11_CHECKPOINTS[state.checkpointsHit];
    if (cp) return { x: cp.x, y: cp.y, label: stage.label };
    return { x: FIXER_GARAGE.x, y: FIXER_GARAGE.y, label: stage.label };
  }
  if (state.missionId === 'm12') {
    if (stage.id === 'bank-shootout') {
      const e = nearestAliveEnemy(state, pos.x, pos.y);
      if (e) return { x: e.x, y: e.y, label: stage.label };
      return { x: BANK.x, y: BANK.y, label: stage.label };
    }
    if (stage.id === 'grab-loot') {
      return { x: BANK.x, y: BANK.y, label: stage.label };
    }
    if (stage.id === 'escape-airport') {
      return { x: AIRPORT.x, y: AIRPORT.y, label: stage.label };
    }
    return { x: M12_PLANE.x, y: M12_PLANE.y, label: stage.label };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helicopter
// ---------------------------------------------------------------------------

// Should the helicopter be up right now? In m9 for the whole
// mission; in m12 for the bank shootout and the airport escape.
export function act2HelicopterWanted(game) {
  const state = game.act2;
  if (!state || state.completed || state.failed) return false;
  if (state.missionId === 'm9') return true;
  if (state.missionId === 'm12') {
    const stage = act2CurrentStage(game);
    return !!stage && (stage.id === 'bank-shootout' || stage.id === 'escape-airport');
  }
  return false;
}

// True while the helicopter's spotlight is on Rook. The main loop
// feeds this into updateWantedHeat as sense.spotlightOnRook, which
// blocks heat decay — hiding does not work under the spotlight.
export function act2SpotlightOnRook(game) {
  const state = game.act2;
  if (!state) return false;
  if (!act2HelicopterWanted(game)) return false;
  if (state.heli.retreating) return false;
  if (game.helicopter && game.helicopter.retreating) return false;
  return true;
}

export function act2HelicopterStatus(game) {
  const state = game.act2;
  if (!state) return { active: false, retreating: false, retreatLeft: 0, hp: 0 };
  const live = game.helicopter;
  return {
    active: act2HelicopterWanted(game),
    retreating: live ? !!live.retreating : state.heli.retreating,
    retreatLeft: live ? (live.retreatLeft || 0) : state.heli.retreatLeft,
    hp: live ? (live.hp != null ? live.hp : state.heli.hp) : state.heli.hp,
  };
}

// Rook shot the helicopter. Enough damage makes it smoke and
// retreat for 20 seconds; it returns afterwards if wanted is
// still 3 stars or more.
export function act2OnHelicopterHit(game, damage) {
  const state = game.act2;
  if (!state) return false;
  const amount = damage || 0;
  const live = game.helicopter;
  const hpBefore = live && live.hp != null ? live.hp : state.heli.hp;
  const hpAfter = hpBefore - amount;
  state.heli.hp = hpAfter;
  if (live) live.hp = hpAfter;
  if (hpAfter > 0) return false;
  // Shot down (for now): smoke, retreat, come back fresh.
  state.heli.retreating = true;
  state.heli.retreatLeft = HELICOPTER_RETREAT_SECONDS;
  state.heli.hp = HELICOPTER_HP;
  if (live) {
    live.retreating = true;
    live.retreatLeft = HELICOPTER_RETREAT_SECONDS;
    live.hp = HELICOPTER_HP;
  }
  return true;
}

export function act2UpdateHelicopter(game, dt) {
  const state = game.act2;
  if (!state) return;
  if (!state.heli.retreating) return;
  state.heli.retreatLeft -= dt;
  if (game.helicopter) game.helicopter.retreatLeft = state.heli.retreatLeft;
  if (state.heli.retreatLeft > 0) return;
  state.heli.retreating = false;
  state.heli.retreatLeft = 0;
  // It returns only if wanted is still 3 stars or more.
  const stars = game.wanted ? game.wanted.stars || 0 : 0;
  if (stars < 3) {
    state.heli.active = false;
  } else {
    state.heli.active = true;
  }
  if (game.helicopter) {
    game.helicopter.retreating = false;
    game.helicopter.retreatLeft = 0;
  }
}

// ---------------------------------------------------------------------------
// Enemies, crates, pickups
// ---------------------------------------------------------------------------

// One frame of enemy behaviour: stand their ground, face Rook,
// and fire aimed shots when he is in range. Enemies use the pistol
// only, fire slowly, and never all at once — the shootout is meant
// to be survivable with the cover and health pickups in the arena.
export function act2UpdateEnemies(game, dt) {
  const state = game.act2;
  if (!state) return;
  const player = game.player || {};
  if (player.health != null && player.health <= 0) return;
  for (const e of state.enemies) {
    if (!e.alive) continue;
    e.fireCooldown -= dt;
    const d = distanceBetween(e, player);
    e.angle = Math.atan2((player.y || 0) - e.y, (player.x || 0) - e.x);
    if (d > ENEMY_FIRE_RANGE || e.fireCooldown > 0) continue;
    e.fireCooldown = ENEMY_FIRE_INTERVAL + Math.random() * 0.6;
    if (Math.random() > ENEMY_HIT_CHANCE) continue;
    if (game.damagePlayer) {
      game.damagePlayer(ENEMY_HIT_DAMAGE, 'enemy');
    } else if (player.health != null) {
      player.health = Math.max(0, player.health - ENEMY_HIT_DAMAGE);
    }
  }
}

// Called by the combat module (or the main loop) when an enemy's
// health reaches zero. Returns true when that kill cleared the
// current shootout stage.
export function act2OnEnemyDown(game, enemy) {
  const state = game.act2;
  if (!state || !enemy) return false;
  const found = state.enemies.find((e) => e.id === enemy.id);
  if (found) found.alive = false;
  else if (enemy.alive !== false) enemy.alive = false;
  return aliveEnemies(state).length === 0;
}

// Walk-over pickups: weapon crates arm Rook with a better weapon,
// ammo crates top his ammo up, health pickups heal him. Called
// every frame while a mission is active; harmless when nothing is
// in range.
export function act2UpdatePickups(game) {
  const state = game.act2;
  if (!state) return;
  const player = game.player || {};
  if (!player.onFoot && !player.inCar) {
    // Crates and health are on-foot pickups; a driver cannot grab
    // them through the windshield.
    if (player.inCar) return;
  }
  const pos = playerPosition(game);

  for (const crate of state.crates) {
    if (crate.taken) continue;
    if (distanceBetween(pos, crate) > CRATE_RADIUS) continue;
    crate.taken = true;
    if (crate.kind === 'ammo') {
      if (player.ammo != null) player.ammo += 60;
      if (game.giveAmmo) game.giveAmmo(60);
    } else {
      state.armed = true;
      if (game.giveWeapon) {
        game.giveWeapon(crate.kind);
      } else {
        player.weapon = crate.kind;
        if (!player.weapons) player.weapons = ['pistol'];
        if (player.weapons.indexOf(crate.kind) === -1) {
          player.weapons.push(crate.kind);
        }
        player.ammo = 120;
      }
    }
  }

  for (const pickup of state.pickups) {
    if (pickup.taken) continue;
    if (distanceBetween(pos, pickup) > PICKUP_RADIUS) continue;
    pickup.taken = true;
    if (player.health != null) {
      const max = player.maxHealth || 100;
      player.health = Math.min(max, player.health + pickup.amount);
    }
  }
}

// ---------------------------------------------------------------------------
// Garage + delivery hooks (m11)
// ---------------------------------------------------------------------------

// Called by the garage module the moment a purchase lands. The
// mission completes its garage stage only after a purchase AND all
// three delivery checkpoints, in the car that was upgraded.
export function act2OnGaragePurchase(game, key) {
  const state = game.act2;
  if (!state || state.missionId !== 'm11') return false;
  const stage = act2CurrentStage(game);
  if (!stage || stage.id !== 'garage') return false;
  const player = game.player || {};
  state.boughtUpgrade = true;
  state.upgradedCarId = player.car ? player.car.id : null;
  state.boughtKey = key || 'unknown';
  advanceStage(game);
  return true;
}

// A delivery checkpoint only counts while Rook is driving the car
// that was upgraded at the Fixer Garage.
export function act2OnCheckpoint(game) {
  const state = game.act2;
  if (!state || state.missionId !== 'm11') return false;
  const stage = act2CurrentStage(game);
  if (!stage || stage.id.indexOf('delivery-') !== 0) return false;
  const player = game.player || {};
  if (!player.inCar || !player.car) return false;
  if (state.upgradedCarId != null && player.car.id !== state.upgradedCarId) {
    return false;
  }
  state.checkpointsHit += 1;
  advanceStage(game);
  return true;
}

// ---------------------------------------------------------------------------
// Per-mission stage checks
// ---------------------------------------------------------------------------

function checkM9(game, dt) {
  const state = game.act2;
  const pos = playerPosition(game);
  if (distanceBetween(pos, HIDEOUT) < MARKER_RADIUS) {
    return 'complete';
  }
  return 'active';
}

function checkM10(game, dt) {
  const state = game.act2;
  const stage = act2CurrentStage(game);
  if (!stage) return 'complete';
  const pos = playerPosition(game);

  if (stage.id === 'arm-up') {
    const player = game.player || {};
    const ownsBetter = (player.weapons || []).some(
      (w) => w === 'smg' || w === 'shotgun',
    ) || player.weapon === 'smg' || player.weapon === 'shotgun';
    if (state.armed || ownsBetter) {
      advanceStage(game);
    }
    return 'active';
  }
  if (stage.id === 'clear-arena') {
    if (aliveEnemies(state).length === 0) {
      advanceStage(game);
    }
    return 'active';
  }
  if (distanceBetween(pos, M10_EXIT) < MARKER_RADIUS) {
    return 'complete';
  }
  return 'active';
}

function checkM11(game, dt) {
  const state = game.act2;
  const stage = act2CurrentStage(game);
  if (!stage) return 'complete';
  if (stage.id === 'garage') {
    // The garage stage only advances on a real purchase, handled
    // by act2OnGaragePurchase. Being parked in the zone is not
    // enough — the mission says buy at least one upgrade.
    return 'active';
  }
  const cp = M11_CHECKPOINTS[state.checkpointsHit];
  if (!cp) return 'complete';
  const pos = playerPosition(game);
  if (distanceBetween(pos, cp) < MARKER_RADIUS) {
    act2OnCheckpoint(game);
    if (state.checkpointsHit >= M11_CHECKPOINTS.length) {
      return 'complete';
    }
  }
  return 'active';
}

function checkM12(game, dt) {
  const state = game.act2;
  const stage = act2CurrentStage(game);
  if (!stage) return 'complete';
  const pos = playerPosition(game);

  if (stage.id === 'bank-shootout') {
    if (aliveEnemies(state).length === 0) {
      advanceStage(game);
    }
    return 'active';
  }
  if (stage.id === 'grab-loot') {
    if (distanceBetween(pos, BANK) < LOOT_RADIUS) {
      state.lootGrabbed = true;
      advanceStage(game);
    }
    return 'active';
  }
  if (stage.id === 'escape-airport') {
    if (distanceBetween(pos, AIRPORT) < 140) {
      advanceStage(game);
    }
    return 'active';
  }
  if (distanceBetween(pos, M12_PLANE) < MARKER_RADIUS) {
    return 'complete';
  }
  return 'active';
}

// ---------------------------------------------------------------------------
// Completion, failure, restart
// ---------------------------------------------------------------------------

function completeAct2Mission(game) {
  const state = game.act2;
  if (!state) return null;
  const mission = act2MissionById(state.missionId);
  if (!mission) return null;
  state.completed = true;
  if (typeof game.cash === 'number') game.cash += mission.reward;
  if (game.addCash) game.addCash(mission.reward);
  if (!game.completedMissions) game.completedMissions = [];
  if (game.completedMissions.indexOf(mission.id) === -1) {
    game.completedMissions.push(mission.id);
  }
  if (game.highestMission == null || mission.id > game.highestMission) {
    game.highestMission = mission.id;
  }
  if (game.onMissionComplete) game.onMissionComplete(mission);
  // Autosave after each mission writes to the active slot.
  if (game.autosave) game.autosave();
  return mission;
}

function failAct2Mission(game, reason) {
  const state = game.act2;
  if (!state) return null;
  const mission = act2MissionById(state.missionId);
  state.failed = true;
  state.failReason = reason;
  if (game.onMissionFailed) game.onMissionFailed(mission, reason);
  return mission;
}

// A failed mission restarts from stage 0: Rook is put back where
// the mission began, healed, and the mission starts over fresh.
// The host calls this when the player (or the autopilot) retries.
export function restartAct2Mission(game) {
  const state = game.act2;
  if (!state) return null;
  const id = state.missionId;
  const player = game.player || {};
  player.x = state.startX;
  player.y = state.startY;
  if (player.maxHealth != null) player.health = player.maxHealth;
  else if (player.health != null) player.health = 100;
  if (player.car && player.car.maxHealth != null) {
    player.car.health = player.car.maxHealth;
  }
  if (game.caught) game.caught = false;
  return startAct2Mission(game, id);
}

// Advance one frame of the active Act 2 mission. Returns a status
// object the host mission framework can act on:
//   { status: 'active' }    — still running
//   { status: 'complete', mission } — reward paid, autosave queued
//   { status: 'failed', mission, reason } — 'down' | 'caught' | 'time'
//   null — no Act 2 mission is active
export function updateAct2Mission(game, dt) {
  const state = game.act2;
  if (!state || state.completed || state.failed) return null;
  const mission = act2MissionById(state.missionId);
  if (!mission) return null;

  // The clock. A generous limit, but it is a limit.
  state.timeLeft -= dt;
  if (state.timeLeft <= 0) {
    const failed = failAct2Mission(game, 'time');
    return { status: 'failed', mission: failed, reason: 'time' };
  }

  // Down or caught ends the attempt; the host restarts from stage 0.
  const player = game.player || {};
  if (player.health != null && player.health <= 0) {
    const failed = failAct2Mission(game, 'down');
    return { status: 'failed', mission: failed, reason: 'down' };
  }
  if (game.caught) {
    const failed = failAct2Mission(game, 'caught');
    return { status: 'failed', mission: failed, reason: 'caught' };
  }

  act2UpdateHelicopter(game, dt);
  act2UpdateEnemies(game, dt);
  act2UpdatePickups(game);

  let result = 'active';
  if (mission.id === 'm9') result = checkM9(game, dt);
  else if (mission.id === 'm10') result = checkM10(game, dt);
  else if (mission.id === 'm11') result = checkM11(game, dt);
  else if (mission.id === 'm12') result = checkM12(game, dt);

  if (result === 'complete') {
    const done = completeAct2Mission(game);
    return { status: 'complete', mission: done };
  }
  return { status: 'active', mission };
}

// Small status snapshot for the HUD and the playtest harness.
export function act2MissionStatus(game) {
  const state = game.act2;
  if (!state) return { active: false };
  const mission = act2MissionById(state.missionId);
  const stage = act2CurrentStage(game);
  return {
    active: true,
    missionId: state.missionId,
    name: mission ? mission.name : state.missionId,
    fixer: mission ? mission.fixer : '',
    stage: stage ? stage.id : '',
    stageLabel: stage ? stage.label : '',
    objective: act2ObjectiveText(game),
    timeLeft: Math.max(0, Math.ceil(state.timeLeft)),
    enemiesLeft: aliveEnemies(state).length,
    checkpointsHit: state.checkpointsHit,
    checkpointsTotal: state.missionId === 'm11' ? M11_CHECKPOINTS.length : 0,
    boughtUpgrade: state.boughtUpgrade,
    lootGrabbed: state.lootGrabbed,
    heli: act2HelicopterStatus(game),
    target: act2CurrentTarget(game),
  };
}

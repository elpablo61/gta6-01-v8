// Autopilot — the driver that plays the game (Crescent Bay).
//
// Fresh from prose spec §4 + §9.1/§9.2 + rebuild notes §3 + diagnosis
// D3 (the m2 -> m3 handoff freeze). This module drives every playtest
// arc run and every screenshot pose, so it must handle all 12 missions.
// It never reads mission code: it reads only the shared game state
// (mission id / stage / target, dialog, enemies, pickups, courier) and
// the world landmarks, and it drives through the same inputs a human
// uses (move vector, aim, mouse, E) plus the shared driving core.
//
// How it works, per mode:
//   goto     — drive (or walk) to a fixed landmark: road graph to the
//              nearest junction, then the final leg straight to the
//              landmark. The final leg is LATCHED once reached (never
//              pulled back to the junction — the flip-flop that broke
//              earlier builds). On foot it follows the road graph to
//              the nearest road point, then the last leg on foot, with
//              the walk target memoized (recomputed only when the
//              target moves more than 120).
//   chase    — m2: follow the courier with followMovingTarget, cruise
//              520 vs courier 380; a ram hit counts within 70 units
//              while speed is over 120. If the courier leaves the
//              world or stops being a valid target, do NOT chase it
//              forever: fall back to the mission's current target and
//              note the loss.
//   shootout — walk straight at the nearest enemy until in range,
//              shoot in aimed bursts every 0.45s (never spray), grab
//              arena ammo when the current weapon is at 6 or fewer,
//              pick up a better weapon crate when one is in the arena.
//   escape   — drive to the Spray Shop and wait for the heat to fall.
//   garage   — m11: drive to the Fixer Garage, open the menu, buy the
//              cheapest available upgrade, close, continue.
//   collect  — m6: drive / walk to the nearest untaken money drop.
//   dialog   — a mission dialog is open: press E to accept, BEFORE
//              any car search (the v1 deadlock: the dialog branch ran
//              before the autopilot, so E could never be pressed).
//   idle     — no mission, no target: hold position, keep moving if a
//              helicopter spotlight is on Rook.
//
// THE M3 HANDOFF FIX (diagnosis D3 — the bug this file must not repeat):
// m2 -> m3 failed on the first attempt because the mission name and
// timer switched to m3 while the checkpoint target was never installed,
// the driver stayed in courier-chase mode with a frozen target, and the
// car locked up completely (even a human could not move it). So EVERY
// time a new mission starts — including a handoff between missions —
// this module: (1) installs the new mission's target (for m3: the club
// checkpoint first), (2) switches the driver to go-to mode for that
// target, (3) makes sure the car can move (clears any stale route /
// route destination / recover flag on the player's car), and (4) drops
// every leftover from the previous mission (the courier is released,
// never left attached to the player). The acceptance test is: within
// the first 5 seconds of m3 the objective banner reads the club
// checkpoint and the car is already moving. One more guard: if chase
// mode ever has no valid target, it falls back to go-to mode at once —
// the autopilot NEVER chases a target that no longer exists. (If the
// mission-switch logic itself lives in missions.js and still fails to
// install the target, this side alone cannot fix it — the finisher
// must repair missions.js; see the builder report.)
//
// Car choice: a slow car is abandoned for a much faster parked car
// nearby — only when the current top speed is under 350 (go-to) or
// under 430 (chase) and a faster parked car is within 200 / 320.
// Switching cars is a theft that adds heat, so never switch for a
// marginal gain. On foot, the fast parked car is preferred over the
// nearest car (the loop where Rook kept re-entering the slow car he
// had just left).
//
// Shared-state contract (everything read defensively):
//   game.player { x, y, angle, onFoot, car, speed, health, ammo, weapon }
//   game.cars, game.enemies, game.pickups, game.peds
//   game.mission { id, stage, target, courier, checkpoints, enemies }
//   game.missionTarget / game.objectiveTarget — current target point.
//   game.dialog / game.missionDialog { open, visible } — fixer dialog.
//   game.world.landmarks — club, marina, airport, hideout, docks, bank,
//                plane, fixerGarage, sprayShop, gunStore, market, downtown.
//   game.weapons { nearestCrate(), nearestAmmoPickup(), needsAmmo(),
//                  hudText() } — arena pickups.
//   game.combat { nearestEnemy(), enemiesAlive() } — shootout helpers.
//   game.garage { open(), close(), buyCheapestAvailable(), isPlayerInZone() }
//   game.helicopter { spotlightOnPlayer } / game.spotlightOnPlayer.
//   game.courier / game.mission.courier — the m2 courier car.
//   game.input { moveX, moveY, sprint, aimX, aimY, mouseDown,
//                interactPressed, press(code), keys:Set } — written by
//                this module, read by player.js.
//   game.autopilotDrove — set true on frames this module drives the car;
//                player.js skips manual driving on those frames.
//   game.now / game.time.now — seconds.

import {
  buildRoute,
  driveCarToward,
  followMovingTarget,
  findNearestParkedCar,
  findNearestCar,
  nearestRoadPoint,
  nearestJunction,
  effectiveTopSpeed,
  applyCarPhysics,
  isOnRoad,
  angDiff,
} from './traffic.js';
import { LANDMARKS } from './world.js';
import { exitCar, tryEnterCar } from './player.js';

export const AUTOPILOT_CHASE_CRUISE = 520;
export const AUTOPILOT_COURIER_CRUISE = 380;
export const AUTOPILOT_GOTO_CRUISE = 420;
export const AUTOPILOT_ESCAPE_CRUISE = 480;
export const AUTOPILOT_SLOW_CAR_GOTO = 350;
export const AUTOPILOT_SLOW_CAR_CHASE = 430;
export const AUTOPILOT_FAST_CAR_GOTO_RANGE = 200;
export const AUTOPILOT_FAST_CAR_CHASE_RANGE = 320;
export const AUTOPILOT_WALK_MEMO_DISTANCE = 120;
export const AUTOPILOT_SHOOT_BURST_INTERVAL = 0.45;
export const AUTOPILOT_SHOOT_RANGE = 260;
export const AUTOPILOT_LOW_AMMO = 6;
export const AUTOPILOT_RAM_DISTANCE = 70;
export const AUTOPILOT_RAM_SPEED = 120;
export const AUTOPILOT_STUCK_SECONDS = 4;
export const AUTOPILOT_COURIER_LOST_SECONDS = 5;

const WORLD_EDGE = 3200;

// Mission plan fallback: what each mission wants, by id and stage,
// when the mission system itself publishes no target. Landmarks come
// from world.js; stages advance as the mission system reports them.
const MISSION_PLAN = {
  m1: [{ landmark: 'market' }, { landmark: 'downtown' }],
  m2: [{ mode: 'chase' }],
  m3: [{ landmark: 'club' }, { landmark: 'marina' }, { landmark: 'airport' }],
  m4: [{ landmark: 'marina' }, { landmark: 'hideout' }],
  m5: [{ landmark: 'club' }, { landmark: 'docks' }],
  m6: [{ mode: 'collect' }, { landmark: 'hideout' }],
  m7: [{ landmark: 'airport' }, { mode: 'escape' }],
  m8: [{ mode: 'shootout' }, { mode: 'escape' }],
  m9: [{ landmark: 'hideout' }],
  m10: [{ mode: 'shootout' }, { mode: 'goto-exit' }],
  m11: [{ mode: 'garage' }, { landmark: 'club' }, { landmark: 'marina' }, { landmark: 'airport' }],
  m12: [{ mode: 'shootout' }, { landmark: 'bank' }, { landmark: 'airport' }, { landmark: 'plane' }],
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function landmarkPoint(game, name) {
  const marks = (game && game.world && game.world.landmarks) || LANDMARKS;
  const m = marks && marks[name];
  if (m && typeof m.x === 'number') return { x: m.x, y: m.y, label: m.label || name, static: true };
  return null;
}

function nowSeconds(game, fallback) {
  if (game && typeof game.now === 'number') return game.now;
  if (game && game.time && typeof game.time.now === 'number') return game.time.now;
  return fallback || 0;
}

export function createAutopilot(game) {
  const state = {
    enabled: true,
    mode: 'idle',
    missionId: null,
    stage: -1,
    target: null,
    targetLabel: '',
    walkMemo: null,
    walkRoute: [],
    walkIndex: 0,
    finalLegLatched: null,
    carSwapTarget: null,
    carSwapCooldownUntil: 0,
    lastShotAt: -10,
    garageDone: false,
    garageStep: 'drive',
    lastPos: { x: 0, y: 0 },
    lastPosAt: 0,
    stuckT: 0,
    courier: null,
    courierLostT: 0,
    courierLost: false,
    courierSwaps: 0,
    lastCourierId: null,
    notes: [],
    framesRun: 0,
    t: 0,
  };

  function note(text) {
    state.notes.push({ at: Math.round(state.t * 10) / 10, text });
    if (state.notes.length > 40) state.notes.shift();
    if (game) game.autopilotNote = text;
  }

  function playerObj() {
    return (game && game.player) || null;
  }

  function inputObj() {
    if (!game) return null;
    if (!game.input) game.input = {};
    return game.input;
  }

  // ---- input helpers (the same inputs a human uses) -----------------

  function pressInteract() {
    const input = inputObj();
    if (!input) return;
    input.interactPressed = true;
    input.ePressed = true;
    if (input.keys && typeof input.keys.add === 'function') input.keys.add('KeyE');
    if (typeof input.press === 'function') {
      try { input.press('KeyE'); } catch (e) { /* ignore */ }
    }
    if (game && typeof game.acceptDialog === 'function') {
      try { game.acceptDialog(); } catch (e) { /* ignore */ }
    }
  }

  function setMove(dx, dy, sprint) {
    const input = inputObj();
    if (!input) return;
    const len = Math.hypot(dx, dy) || 1;
    input.moveX = dx / len;
    input.moveY = dy / len;
    // Sprint is a read-only getter over the held-key set (main.js
    // defines it with no setter), so assigning it throws and kills
    // the whole autopilot update — Rook froze mid-mission in the m1
    // probe the moment a move was set. Sprint only through the key
    // set: holding ShiftLeft is what the getter reads.
    if (input.keys && typeof input.keys.add === 'function') {
      if (dx < -0.3) input.keys.add('KeyA');
      if (dx > 0.3) input.keys.add('KeyD');
      if (dy < -0.3) input.keys.add('KeyW');
      if (dy > 0.3) input.keys.add('KeyS');
      if (sprint) input.keys.add('ShiftLeft');
      else input.keys.delete('ShiftLeft');
    }
  }

  function clearMove() {
    const input = inputObj();
    if (!input) return;
    input.moveX = 0;
    input.moveY = 0;
    // Never assign input.sprint: it is a getter-only property (see
    // setMove). Clearing the Shift keys releases the sprint instead.
    input.mouseDown = false;
    if (input.keys && typeof input.keys.delete === 'function') {
      for (const k of ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight']) input.keys.delete(k);
    }
  }

  function aimAt(x, y) {
    const input = inputObj();
    if (!input) return;
    input.aimX = x;
    input.aimY = y;
    input.mouseWorldX = x;
    input.mouseWorldY = y;
  }

  // ---- mission state --------------------------------------------------

  function dialogOpen() {
    if (!game) return false;
    const d = game.dialog || game.missionDialog;
    if (d && (d.open || d.visible)) return true;
    return false;
  }

  function missionId() {
    return (game && game.mission && game.mission.id) || null;
  }

  function missionStage() {
    if (game && game.mission && typeof game.mission.stage === 'number') return game.mission.stage;
    return 0;
  }

  // The M3 handoff fix: on ANY mission start (including a handoff),
  // install the new target, switch to go-to for it, make the car
  // movable again, and drop every leftover from the previous mission.
  function resetForNewMission(id, stage) {
    state.missionId = id;
    state.stage = stage;
    state.walkMemo = null;
    state.walkRoute = [];
    state.walkIndex = 0;
    state.finalLegLatched = null;
    state.carSwapTarget = null;
    state.garageDone = false;
    state.garageStep = 'drive';
    state.courier = null;
    state.courierLostT = 0;
    state.courierLost = false;
    state.stuckT = 0;
    state.lastPos = { x: 0, y: 0 };
    state.lastPosAt = state.t;
    // Release the old courier and unstick the car: a stale route or a
    // stuck recover flag is what locked the car solid in the D3 freeze.
    const p = playerObj();
    if (p && p.car) {
      p.car.route = [];
      p.car.routeDest = null;
      p.car.recover = false;
      p.car.reverseT = 0;
      p.car.stuckT = 0;
    }
    if (game) {
      game.courier = null;
      if (game.mission) game.mission.courier = null;
    }
    resolveTarget();
    note('mission ' + id + ' started — target: ' + (state.targetLabel || 'none') + ', mode ' + state.mode);
  }

  function publishedTarget() {
    if (!game) return null;
    const cands = [game.missionTarget, game.objectiveTarget];
    if (game.mission && game.mission.target) cands.push(game.mission.target);
    if (game.mission && game.mission.checkpoint) cands.push(game.mission.checkpoint);
    for (const c of cands) {
      if (c && typeof c.x === 'number' && typeof c.y === 'number') {
        return { x: c.x, y: c.y, label: c.label || 'mission target', static: true };
      }
    }
    return null;
  }

  function planStep() {
    const plan = MISSION_PLAN[state.missionId];
    if (!plan) return null;
    return plan[Math.min(state.stage, plan.length - 1)] || plan[0];
  }

  // Decide the mode + target for the current mission and stage. The
  // published target (from missions.js) wins; the plan below is the
  // fallback when the mission system publishes nothing.
  function resolveTarget() {
    const id = state.missionId;
    const step = planStep();
    // Shootout / chase / collect / garage / escape are modes, not points.
    if (step && step.mode) {
      // A lost courier stays lost: re-deriving 'chase' from the plan
      // would undo the fallback one frame later (the T5 loop). Only
      // resume the chase if a VALID courier exists again.
      if (step.mode === 'chase' && state.courierLost) {
        const again = findCourier();
        if (courierValid(again)) {
          state.courierLost = false;
          state.courier = again;
          note('courier back in the world — resuming chase');
        } else {
          const pub = publishedTarget();
          if (pub) {
            state.mode = 'goto';
            state.target = pub;
            state.targetLabel = pub.label;
            return;
          }
          state.mode = 'idle';
          state.target = null;
          state.targetLabel = 'courier lost — waiting for mission target';
          return;
        }
      }
      state.mode = step.mode;
      state.target = null;
      if (step.mode === 'chase') state.targetLabel = 'chase the courier';
      else if (step.mode === 'shootout') state.targetLabel = 'clear the arena';
      else if (step.mode === 'escape') state.targetLabel = 'escape to the Spray Shop';
      else if (step.mode === 'garage') state.targetLabel = 'Fixer Garage';
      else if (step.mode === 'collect') state.targetLabel = 'collect the money drops';
      else if (step.mode === 'goto-exit') state.targetLabel = 'reach the exit marker';
      // A published target still overrides a mode's destination.
      const pub = publishedTarget();
      if (pub && (step.mode === 'goto-exit' || step.mode === 'escape')) state.target = pub;
      if (step.mode === 'escape') state.target = landmarkPoint(game, 'sprayShop');
      return;
    }
    // Checkpoints list (m3 / m11): the mission's own list wins.
    if (game && game.mission && Array.isArray(game.mission.checkpoints) && game.mission.checkpoints.length) {
      const cp = game.mission.checkpoints[Math.min(state.stage, game.mission.checkpoints.length - 1)];
      if (cp && typeof cp.x === 'number') {
        state.mode = 'goto';
        state.target = { x: cp.x, y: cp.y, label: cp.label || 'checkpoint', static: true };
        state.targetLabel = state.target.label;
        return;
      }
    }
    const pub = publishedTarget();
    if (pub) {
      state.mode = 'goto';
      state.target = pub;
      state.targetLabel = pub.label;
      return;
    }
    if (step && step.landmark) {
      const pt = landmarkPoint(game, step.landmark);
      if (pt) {
        state.mode = 'goto';
        state.target = pt;
        state.targetLabel = pt.label;
        return;
      }
    }
    state.mode = 'idle';
    state.target = null;
    state.targetLabel = '';
  }

  // ---- courier (m2) ---------------------------------------------------

  function findCourier() {
    if (!game) return null;
    const cands = [];
    if (game.mission && game.mission.courier) cands.push(game.mission.courier);
    if (game.courier) cands.push(game.courier);
    for (const car of game.cars || []) {
      if (car && (car.isCourier || car.courier)) cands.push(car);
    }
    for (const c of cands) {
      if (c && typeof c.x === 'number' && typeof c.y === 'number' && !c.wrecked) return c;
    }
    return null;
  }

  function courierValid(c) {
    if (!c || c.wrecked) return false;
    if (typeof c.x !== 'number' || typeof c.y !== 'number') return false;
    // Out of the world = gone for good (the D3 courier kept driving
    // off the edge and being replaced far away, 6+ times).
    if (c.x < -100 || c.x > WORLD_EDGE + 100 || c.y < -100 || c.y > WORLD_EDGE + 100) return false;
    return true;
  }

  // ---- car choice -------------------------------------------------------

  function currentTopSpeed() {
    const p = playerObj();
    if (!p || !p.car) return 0;
    return effectiveTopSpeed(p.car);
  }

  function maybeSwapCar(dt) {
    const p = playerObj();
    if (!p || p.onFoot || !p.car) return false;
    if (state.t < state.carSwapCooldownUntil) return false;
    const threshold = state.mode === 'chase' ? AUTOPILOT_SLOW_CAR_CHASE : AUTOPILOT_SLOW_CAR_GOTO;
    const range = state.mode === 'chase' ? AUTOPILOT_FAST_CAR_CHASE_RANGE : AUTOPILOT_FAST_CAR_GOTO_RANGE;
    const current = currentTopSpeed();
    if (current >= threshold) return false;
    const found = findNearestParkedCar(game, p.x, p.y, current + 50);
    if (!found || found.dist > range) return false;
    // A much faster parked car nearby: leave the slow one for it.
    state.carSwapTarget = found.car;
    state.carSwapCooldownUntil = state.t + 8;
    note('swapping car: top ' + Math.round(current) + ' -> ' + Math.round(effectiveTopSpeed(found.car)) + ' parked ' + Math.round(found.dist) + ' away');
    exitCar(game);
    return true;
  }

  // On foot: prefer a FAST parked car, fall back to the nearest car.
  // (v2 bug 20: picking the nearest car re-entered the slow car just left.)
  function chooseCarToEnter() {
    const p = playerObj();
    if (!p) return null;
    if (state.carSwapTarget && !state.carSwapTarget.wrecked && !state.carSwapTarget.player) {
      const d = Math.hypot(state.carSwapTarget.x - p.x, state.carSwapTarget.y - p.y);
      if (d < 600) return { car: state.carSwapTarget, dist: d };
      state.carSwapTarget = null;
    }
    const fast = findNearestParkedCar(game, p.x, p.y, 400);
    if (fast && fast.dist < 500) return fast;
    const near = findNearestCar(game, p.x, p.y, (c) => !c.wrecked && !c.player);
    if (near && near.dist < 500) return near;
    return null;
  }

  // ---- driving ----------------------------------------------------------

  // Manual recovery onto the road. Why this exists: driveCarToward's own
  // off-road recovery builds a two-point route (nearest road point, then
  // nearest junction) — but when the car sits marginally off-road (a
  // parked car stands ~46 from the centreline; the on-road tolerance is
  // 42) AND near a junction, both recovery points fall inside the 70
  // waypoint pop radius, so the route empties instantly, driveCarToward
  // reports arrived, and nothing ever moves the car again — a permanent
  // stall, every frame. The autopilot therefore steers the car onto the
  // road itself (same stop-and-rotate rule for sharp turns) and only
  // hands over to driveCarToward once the car is properly on-road.
  // (The finisher may harden traffic.js itself — e.g. never pop a
  // recovery waypoint on the frame it was created — but this module
  // must not stall even if it does not.)
  function recoverToRoad(car, dt) {
    const pt = nearestRoadPoint(car.x, car.y);
    const desired = Math.atan2(pt.y - car.y, pt.x - car.x);
    const diff = angDiff(desired, car.angle);
    if (game) game.autopilotDrove = true;
    if (Math.abs(diff) > 0.9) {
      if (Math.abs(car.speed) > 6) {
        applyCarPhysics(car, { throttle: -1, steer: 0 }, dt, game.world, nowSeconds(game, state.t));
      } else {
        car.speed = 0;
        car.angle += clamp(diff, -1, 1) * 2.4 * dt;
      }
      return false;
    }
    const throttle = car.speed < 140 ? 1 : -0.6;
    applyCarPhysics(car, { throttle, steer: clamp(diff * 1.8, -1, 1) }, dt, game.world, nowSeconds(game, state.t));
    return isOnRoad(car.x, car.y);
  }

  // Guarded driving: recover onto the road first, then delegate.
  // Returns true when the car is on-road and the delegate ran.
  function driveGuarded(car, runDelegate, dt) {
    if (!isOnRoad(car.x, car.y)) {
      // Clear the stale recovery route so the next on-road delegation
      // rebuilds cleanly instead of resuming a popped route.
      car.recover = false;
      car.route = [];
      recoverToRoad(car, dt || 1 / 60);
      return false;
    }
    runDelegate();
    return true;
  }

  function driveTo(target, cruise, dt, isStatic) {
    const p = playerObj();
    const car = p && p.car;
    if (!car) return { arrived: false };
    if (game) game.autopilotDrove = true;
    // Final-leg latch: once the car is on the last leg to a static
    // landmark, keep driving at the latched point — never pull back
    // to the junction (the flip-flop that stranded cars at m3).
    if (isStatic && state.finalLegLatched) {
      let res = { arrived: false };
      driveGuarded(car, () => {
        res = driveCarToward(car, state.finalLegLatched.x, state.finalLegLatched.y, cruise, dt, game.world, nowSeconds(game, state.t), { finalLeg: true });
      }, dt);
      if (res.arrived) state.finalLegLatched = null;
      return res;
    }
    let res = { arrived: false };
    driveGuarded(car, () => {
      res = driveCarToward(car, target.x, target.y, cruise, dt, game.world, nowSeconds(game, state.t), { finalLeg: !!isStatic });
    }, dt);
    if (isStatic && !res.arrived && car.route && car.route.length <= 1) {
      const d = Math.hypot(target.x - car.x, target.y - car.y);
      if (d < 420) state.finalLegLatched = { x: target.x, y: target.y };
    }
    return res;
  }

  // Stuck watch: if the car barely moves for a while, force a fresh route.
  function watchStuck(dt) {
    const p = playerObj();
    if (!p || p.onFoot || !p.car) { state.stuckT = 0; return; }
    const moved = Math.hypot(p.x - state.lastPos.x, p.y - state.lastPos.y);
    if (moved > 25) {
      state.stuckT = 0;
      state.lastPos = { x: p.x, y: p.y };
      state.lastPosAt = state.t;
      return;
    }
    state.stuckT += dt;
    if (state.stuckT > AUTOPILOT_STUCK_SECONDS) {
      state.stuckT = 0;
      state.lastPos = { x: p.x, y: p.y };
      const car = p.car;
      car.route = [];
      car.routeDest = null;
      car.recover = false;
      note('car stuck — route cleared, retrying');
    }
  }

  // ---- walking ----------------------------------------------------------

  function walkTargetPoint() {
    // What the feet are heading for: a car to enter, an ammo pickup,
    // a crate, an enemy, or the mission target's road point + final leg.
    if (state.carSwapTarget) return { x: state.carSwapTarget.x, y: state.carSwapTarget.y, kind: 'car' };
    if (state.mode === 'shootout') {
      const enemy = nearestEnemyNow();
      if (enemy) return { x: enemy.x, y: enemy.y, kind: 'enemy' };
    }
    if (state.target) return { x: state.target.x, y: state.target.y, kind: 'target' };
    return null;
  }

  function rebuildWalkRoute(to) {
    const p = playerObj();
    if (!p) return;
    const roadPt = nearestRoadPoint(to.x, to.y);
    const route = buildRoute(p.x, p.y, roadPt.x, roadPt.y);
    // Drop every leading waypoint Rook has already passed. On a
    // shortest grid path each waypoint is closer to the destination
    // than the one before it, so a leading waypoint farther from the
    // destination than Rook is right now sits BEHIND Rook — walking
    // back to it is what pinned Rook in a jitter box at the market
    // junction in the m1 probe (route rebuilt, first waypoint the
    // junction behind him, walk back, pop it, walk on, rebuild again,
    // forever). Cars keep the first junction (their fix); walkers
    // must never be sent backwards.
    const destD = Math.hypot(to.x - p.x, to.y - p.y);
    while (route.length > 0 && Math.hypot(route[0].x - to.x, route[0].y - to.y) > destD) {
      route.shift();
    }
    // Final leg on foot from the road to the exact point.
    route.push({ x: to.x, y: to.y });
    state.walkRoute = route;
    state.walkIndex = 0;
    state.walkMemo = { x: to.x, y: to.y };
  }

  function walkToward(to, dt) {
    const p = playerObj();
    if (!p) return false;
    // Memoize: recompute only when the target moves more than 120.
    if (!state.walkMemo || Math.hypot(to.x - state.walkMemo.x, to.y - state.walkMemo.y) > AUTOPILOT_WALK_MEMO_DISTANCE) {
      rebuildWalkRoute(to);
    }
    let wp = state.walkRoute[state.walkIndex];
    while (wp && Math.hypot(wp.x - p.x, wp.y - p.y) < 40) {
      state.walkIndex += 1;
      wp = state.walkRoute[state.walkIndex];
    }
    if (!wp) return true; // arrived
    setMove(wp.x - p.x, wp.y - p.y, true);
    return false;
  }

  // ---- shootout -----------------------------------------------------------

  function nearestEnemyNow() {
    const p = playerObj();
    if (!p) return null;
    if (game && game.combat && typeof game.combat.nearestEnemy === 'function') {
      try {
        const e = game.combat.nearestEnemy(p.x, p.y, 1200);
        if (e) return e;
      } catch (e) { /* fall through */ }
    }
    let best = null, bestD = Infinity;
    for (const e of game && game.enemies ? game.enemies : []) {
      if (!e || e.alive === false) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function enemiesLeft() {
    if (game && game.combat && typeof game.combat.enemiesAlive === 'function') {
      try { return game.combat.enemiesAlive(); } catch (e) { /* fall through */ }
    }
    let n = 0;
    for (const e of game && game.enemies ? game.enemies : []) {
      if (e && e.alive !== false) n += 1;
    }
    return n;
  }

  function currentAmmo() {
    const p = playerObj();
    if (!p) return 99;
    if (game && game.weapons && typeof game.weapons.ammoFor === 'function') {
      try {
        const cur = game.weapons.hudText ? game.weapons.hudText() : null;
        if (cur && typeof cur.ammo === 'number') return cur.ammo;
      } catch (e) { /* fall through */ }
    }
    if (p.ammo && typeof p.ammo[p.weapon || 'pistol'] === 'number') return p.ammo[p.weapon || 'pistol'];
    return 99;
  }

  function nearestAmmoPoint() {
    const p = playerObj();
    if (!p) return null;
    if (game && game.weapons && typeof game.weapons.nearestAmmoPickup === 'function') {
      try {
        const a = game.weapons.nearestAmmoPickup(1200);
        if (a) return { x: a.x, y: a.y, kind: 'ammo' };
      } catch (e) { /* fall through */ }
    }
    let best = null, bestD = Infinity;
    for (const pk of game && game.pickups ? game.pickups : []) {
      if (!pk || pk.taken || pk.kind !== 'ammo') continue;
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bestD) { bestD = d; best = pk; }
    }
    if (best) return { x: best.x, y: best.y, kind: 'ammo' };
    return null;
  }

  function betterCratePoint() {
    const p = playerObj();
    if (!p) return null;
    if (game && game.weapons && typeof game.weapons.nearestCrate === 'function') {
      try {
        const c = game.weapons.nearestCrate(1200);
        if (!c) return null;
        // Only chase a crate for a weapon Rook does not own yet.
        const owned = p.owned || {};
        if (owned[c.kind]) return null;
        return { x: c.x, y: c.y, kind: 'crate' };
      } catch (e) { return null; }
    }
    return null;
  }

  function stepShootout(dt) {
    const p = playerObj();
    if (!p) return;
    // Low ammo first: walk to the nearest ammo pickup.
    if (currentAmmo() <= AUTOPILOT_LOW_AMMO) {
      const ammoPt = nearestAmmoPoint();
      if (ammoPt) {
        const arrived = walkToward(ammoPt, dt);
        if (!arrived) return;
      }
    }
    // A better weapon crate in the arena (m10): pick it up first.
    const crate = betterCratePoint();
    if (crate) {
      const arrived = walkToward(crate, dt);
      if (!arrived) return;
    }
    const enemy = nearestEnemyNow();
    if (!enemy) {
      clearMove();
      return;
    }
    const d = Math.hypot(enemy.x - p.x, enemy.y - p.y);
    aimAt(enemy.x, enemy.y);
    if (d > AUTOPILOT_SHOOT_RANGE) {
      // Walk straight at the nearest enemy until in range.
      setMove(enemy.x - p.x, enemy.y - p.y, true);
      state.walkMemo = null; // enemy moves: never memoize a moving target
    } else {
      clearMove();
    }
    // Aimed bursts every 0.45s — never spray.
    if (state.t - state.lastShotAt >= AUTOPILOT_SHOOT_BURST_INTERVAL) {
      state.lastShotAt = state.t;
      const input = inputObj();
      if (input) input.mouseDown = true;
    }
  }

  // ---- garage (m11) -------------------------------------------------------

  function stepGarage(dt) {
    const p = playerObj();
    if (!p) return;
    if (state.garageDone) {
      // Purchase done: the mission system advances the stage; the
      // target resolver picks up the checkpoint legs.
      resolveTarget();
      return;
    }
    const spot = landmarkPoint(game, 'fixerGarage');
    if (!spot) { state.garageDone = true; return; }
    const d = Math.hypot(spot.x - p.x, spot.y - p.y);
    if (p.onFoot) {
      // On foot at the garage without a car: find a car first.
      const choice = chooseCarToEnter();
      if (choice) {
        walkToward({ x: choice.car.x, y: choice.car.y, kind: 'car' }, dt);
        if (choice.dist < 78) pressInteract();
      }
      return;
    }
    if (d > 130) {
      driveTo(spot, AUTOPILOT_GOTO_CRUISE, dt, true);
      return;
    }
    // In the zone: open the menu, buy the cheapest upgrade, close.
    if (game && game.garage && typeof game.garage.open === 'function') {
      if (!game.garageOpen) {
        const opened = game.garage.open();
        if (!opened) pressInteract();
        return;
      }
      if (typeof game.garage.buyCheapestAvailable === 'function') {
        const bought = game.garage.buyCheapestAvailable();
        if (bought && bought.ok) {
          note('garage: bought ' + bought.id + ' for $' + bought.price);
          state.garageDone = true;
          if (typeof game.garage.close === 'function') game.garage.close();
          return;
        }
        // Nothing affordable / already maxed: close and carry on — the
        // mission system may still count the visit; do not loop forever.
        note('garage: nothing to buy (' + (bought && bought.reason) + ') — continuing');
        state.garageDone = true;
        if (typeof game.garage.close === 'function') game.garage.close();
        return;
      }
    }
    // No garage module wired: press E and move on after a short wait.
    pressInteract();
    state.garageStep = 'wait';
    if (state.t - (state._garageWaitStarted || 0) > 2) state.garageDone = true;
    if (!state._garageWaitStarted) state._garageWaitStarted = state.t;
  }

  // ---- per-frame update ---------------------------------------------------

  function update(dt) {
    const step = Math.max(0, Math.min(0.1, Number(dt) || 0.016));
    state.t += step;
    state.framesRun += 1;
    if (game) game.autopilotDrove = false;
    if (!state.enabled || !game) return state;
    const p = playerObj();
    if (!p || !p.alive) { clearMove(); return state; }

    // (1) Mission handoff: a new mission id OR a stage change resets
    //     everything — target, mode, courier, stale car route.
    const id = missionId();
    const stage = missionStage();
    if (id !== state.missionId || stage !== state.stage) {
      if (id && id !== state.missionId) resetForNewMission(id, stage);
      else {
        state.stage = stage;
        state.walkMemo = null;
        state.finalLegLatched = null;
        resolveTarget();
        note('mission ' + id + ' stage ' + stage + ' — target: ' + (state.targetLabel || 'none'));
      }
    }
    if (!id) {
      state.mode = 'idle';
      clearMove();
      return state;
    }

    // (2) Dialog first: accept it BEFORE any car search, or the E press
    //     is swallowed and the autopilot can never start the mission.
    if (dialogOpen()) {
      state.mode = 'dialog';
      clearMove();
      pressInteract();
      return state;
    }

    // (3) Helicopter spotlight: never stop under it — keep moving
    //     toward the objective (handled by never idling below).
    const spotlight = !!(game.helicopter && game.helicopter.spotlightOnPlayer) || !!game.spotlightOnPlayer;

    // (4) Mode dispatch.
    if (state.mode === 'chase') {
      stepChase(step);
      return state;
    }
    if (state.mode === 'shootout') {
      // Shootouts are fought on foot; get out of the car near the arena.
      if (!p.onFoot && enemiesLeft() > 0) {
        const enemy = nearestEnemyNow();
        if (enemy && Math.hypot(enemy.x - p.x, enemy.y - p.y) < 500) {
          exitCar(game);
          return state;
        }
      }
      if (p.onFoot) {
        if (enemiesLeft() === 0) {
          // Arena clear: the mission system advances the stage (escape
          // / exit). Until it does, head for the published target.
          const pub = publishedTarget();
          if (pub) {
            state.mode = 'goto';
            state.target = pub;
            state.targetLabel = pub.label;
          } else {
            clearMove();
          }
          return state;
        }
        stepShootout(step);
        return state;
      }
      // Driving to the arena: head for the nearest enemy's road point.
      const enemy = nearestEnemyNow();
      if (enemy) driveTo({ x: enemy.x, y: enemy.y, label: 'arena' }, AUTOPILOT_GOTO_CRUISE, step, false);
      return state;
    }
    if (state.mode === 'garage') {
      stepGarage(step);
      watchStuck(step);
      return state;
    }
    if (state.mode === 'collect') {
      stepCollect(step);
      return state;
    }
    if (state.mode === 'escape') {
      const shop = landmarkPoint(game, 'sprayShop');
      if (shop) {
        if (p.onFoot) {
          stepEnterCarOrWalk(shop, step);
        } else {
          maybeSwapCar(step);
          driveTo(shop, AUTOPILOT_ESCAPE_CRUISE, step, true);
          watchStuck(step);
        }
      }
      return state;
    }
    if (state.mode === 'goto' || state.mode === 'goto-exit') {
      if (!state.target) {
        // No target installed (yet): the mission system may install it
        // a frame later. Do not invent one — but never stand still
        // under a spotlight either.
        if (spotlight && p.onFoot) setMove(1, 0, true);
        else clearMove();
        return state;
      }
      if (p.onFoot) {
        stepEnterCarOrWalk(state.target, step);
      } else {
        maybeSwapCar(step);
        driveTo(state.target, AUTOPILOT_GOTO_CRUISE, step, !!state.target.static);
        watchStuck(step);
      }
      return state;
    }
    // idle: hold still (but keep moving under a spotlight).
    if (spotlight && p.onFoot) setMove(1, 0, true);
    else clearMove();
    return state;
  }

  function stepCollect(dt) {
    const p = playerObj();
    if (!p) return;
    let best = null, bestD = Infinity;
    for (const pk of game && game.pickups ? game.pickups : []) {
      if (!pk || pk.taken) continue;
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bestD) { bestD = d; best = pk; }
    }
    if (game && game.mission && Array.isArray(game.mission.pickups)) {
      for (const pk of game.mission.pickups) {
        if (!pk || pk.taken) continue;
        const d = Math.hypot(pk.x - p.x, pk.y - p.y);
        if (d < bestD) { bestD = d; best = pk; }
      }
    }
    if (!best) {
      // All drops collected: return to the hideout.
      const home = landmarkPoint(game, 'hideout');
      state.mode = 'goto';
      state.target = home;
      state.targetLabel = home ? home.label : 'hideout';
      return;
    }
    const pt = { x: best.x, y: best.y, label: 'money drop', static: true };
    if (p.onFoot) stepEnterCarOrWalk(pt, dt);
    else {
      maybeSwapCar(dt);
      driveTo(pt, AUTOPILOT_GOTO_CRUISE, dt, true);
      watchStuck(dt);
    }
  }

  // On foot toward a destination: enter a car when one is near, else
  // walk the road graph. Entering happens through the same E press a
  // human uses (player.js tryEnterCar).
  function stepEnterCarOrWalk(dest, dt) {
    const p = playerObj();
    if (!p) return;
    const choice = chooseCarToEnter();
    if (choice && choice.dist < 78) {
      clearMove();
      pressInteract();
      tryEnterCar(game);
      state.carSwapTarget = null;
      return;
    }
    // Only a PARKED car (or the car this driver already chose to swap
    // to) is a walk target. A moving traffic car is never chased on
    // foot: its position moves, the walk memo trips every second, the
    // route rebuilds, and Rook gets yanked back to the junction
    // behind him instead of ever reaching a car — the m1 stall. With
    // no parked car near, walk to the destination; a parked car on
    // the way will be picked up then.
    const walkCar =
      choice && choice.dist < 260 && (choice.car.parked || choice.car === state.carSwapTarget)
        ? choice
        : null;
    if (walkCar) {
      // A car is close: walk straight to it instead of the destination.
      const arrived = walkToward({ x: walkCar.car.x, y: walkCar.car.y, kind: 'car' }, dt);
      if (!arrived) return;
    }
    walkToward(dest, dt);
  }

  function stepChase(dt) {
    const p = playerObj();
    if (!p) return;
    let courier = state.courier;
    if (!courierValid(courier)) {
      const found = findCourier();
      if (found && found !== state.courier) {
        if (state.lastCourierId !== null && found.id !== undefined && found.id !== state.lastCourierId) {
          state.courierSwaps += 1;
          note('courier replaced (swap #' + state.courierSwaps + ')');
        }
        if (found.id !== undefined) state.lastCourierId = found.id;
        state.courier = found;
        courier = found;
      } else if (!found) {
        state.courier = null;
        courier = null;
      }
    }
    // No valid courier: NEVER chase a ghost. Fall back to the mission's
    // current target (or idle) and say so.
    if (!courierValid(courier)) {
      state.courierLostT += dt;
      if (state.courierLostT > AUTOPILOT_COURIER_LOST_SECONDS) {
        note('courier lost/invalid for ' + AUTOPILOT_COURIER_LOST_SECONDS + 's — falling back to mission target');
        state.mode = 'goto';
        state.courierLostT = 0;
        state.courierLost = true;
        resolveTarget();
        if (!state.target) {
          clearMove();
          return;
        }
      } else {
        clearMove();
        return;
      }
    } else {
      state.courierLostT = 0;
    }
    if (game) game.courier = courier;
    if (p.onFoot) {
      // On foot: get a car (prefer a fast one), then chase.
      const choice = chooseCarToEnter();
      if (choice && choice.dist < 78) {
        clearMove();
        pressInteract();
        tryEnterCar(game);
        return;
      }
      if (choice) {
        walkToward({ x: choice.car.x, y: choice.car.y, kind: 'car' }, dt);
        return;
      }
      // No car in reach: walk to the courier's nearest road point
      // (never walk at a moving target forever).
      const roadPt = nearestRoadPoint(courier.x, courier.y);
      walkToward({ x: roadPt.x, y: roadPt.y, kind: 'road' }, dt);
      return;
    }
    // Driving: cruise 520, follow the moving target (route rebuilt
    // only when the courier moves >100 from the recorded destination).
    maybeSwapCar(dt);
    if (game) game.autopilotDrove = true;
    driveGuarded(p.car, () => {
      followMovingTarget(p.car, courier, AUTOPILOT_CHASE_CRUISE, dt, game.world, nowSeconds(game, state.t));
    }, dt);
    watchStuck(dt);
    // Ram feedback for the debug snapshot.
    const d = Math.hypot(courier.x - p.x, courier.y - p.y);
    const spd = Math.abs(p.car.speed || 0);
    if (game) game.chaseInfo = { dist: Math.round(d), speed: Math.round(spd), ramReady: d < AUTOPILOT_RAM_DISTANCE && spd > AUTOPILOT_RAM_SPEED };
  }

  function start(missionIdArg) {
    state.enabled = true;
    if (missionIdArg) {
      state.missionId = null; // force a fresh reset on the next update
      if (game && game.mission) game.mission.id = missionIdArg;
    }
    return state;
  }

  function stop() {
    state.enabled = false;
    clearMove();
    if (game) game.autopilotDrove = false;
    return state;
  }

  function enable() {
    state.enabled = true;
    return state;
  }

  function disable() {
    return stop();
  }

  function snapshot() {
    const p = playerObj();
    return {
      enabled: state.enabled,
      mode: state.mode,
      missionId: state.missionId,
      stage: state.stage,
      target: state.target ? { x: Math.round(state.target.x), y: Math.round(state.target.y), label: state.targetLabel } : null,
      finalLegLatched: !!state.finalLegLatched,
      inCar: p ? !p.onFoot : false,
      speed: p ? Math.round(Math.abs(p.speed || 0)) : 0,
      x: p ? Math.round(p.x) : 0,
      y: p ? Math.round(p.y) : 0,
      courierSwaps: state.courierSwaps,
      courierLostT: Math.round(state.courierLostT * 10) / 10,
      framesRun: state.framesRun,
      notes: state.notes.slice(-6),
    };
  }

  return {
    state,
    update,
    step: update,
    start,
    stop,
    enable,
    disable,
    snapshot,
    resolveTarget,
    resetForNewMission,
  };
}

export default createAutopilot;

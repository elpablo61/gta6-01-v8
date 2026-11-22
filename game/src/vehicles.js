// Crescent Bay — car physics, steering and route-following.
//
// Every car in the city (player cars, traffic, police, the courier) is
// built by createCar and driven by updateCar. Steering is radius-based
// so a car can turn inside a 64-wide road, and any turn sharper than
// about 52 degrees is done stopped, rotating in place, then driving
// straight — a moving turning circle is wider than the road.
//
// Route-following always starts at the FIRST junction on the route
// (never a diagonal cut across a block) and, once the final junction
// is reached, drives the last leg straight to the exact target — but
// only for fixed landmarks, never for a moving target.

import {
  WORLD_W,
  WORLD_H,
  ROAD_POSITIONS,
  ROAD_WIDTH,
  ROAD_HALF,
  CAR_TYPES,
} from './config.js';

const SHARP_TURN_ANGLE = 0.9; // ~52 degrees: stop and rotate in place
const U_TURN_ANGLE = 2.6; // U-turn: crawl at speed 60
const WAYPOINT_REACH = 70; // accept a waypoint inside this distance
const CRAWL_NEAR_WAYPOINT = 170; // crawl at 120 inside this distance
const ON_ROAD_TOLERANCE = 42; // distance from a centreline that counts as on-road
const WALL_DAMAGE_INTERVAL = 0.5; // wall damage ticks at most once per 0.5 s
const TURN_RADIUS_BASE = 80; // turn radius grows with speed: 80 + 0.3 * speed
const TURN_RADIUS_SPEED = 0.3;
const MIN_TURN_RATE = 1.4; // guaranteed turn authority even at low speed
const REVERSE_UNWEDGE_TIME = 1.2; // seconds of straight reversing when stuck
const STUCK_SPEED = 12; // below this while trying to move counts as stuck
const STUCK_TIME = 1.5; // seconds of no progress before unwedging
const SMOKE_HEALTH = 50; // below this health the car smokes
const MAX_SKID_MARKS = 24;

let nextCarId = 1;

export function angleDifference(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function distanceBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Road graph helpers (built from the config road grid) ------------
// Junctions sit where a vertical road crosses a horizontal road. A
// route is a list of junction points found by BFS, always starting
// with the junction nearest the car's current position.

export function nearestRoadPoint(x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const rx of ROAD_POSITIONS) {
    const d = Math.abs(x - rx);
    if (d < bestDist) {
      bestDist = d;
      best = { x: rx, y: clamp(y, 0, WORLD_H), dist: d, vertical: true };
    }
  }
  for (const ry of ROAD_POSITIONS) {
    const d = Math.abs(y - ry);
    if (d < bestDist) {
      bestDist = d;
      best = { x: clamp(x, 0, WORLD_W), y: ry, dist: d, vertical: false };
    }
  }
  return best;
}

export function nearestJunction(x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const jx of ROAD_POSITIONS) {
    for (const jy of ROAD_POSITIONS) {
      const dx = x - jx;
      const dy = y - jy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = { x: jx, y: jy };
      }
    }
  }
  return best;
}

function junctionIndex(ix, iy) {
  return iy * ROAD_POSITIONS.length + ix;
}

function junctionCoords(index) {
  const n = ROAD_POSITIONS.length;
  return {
    x: ROAD_POSITIONS[index % n],
    y: ROAD_POSITIONS[Math.floor(index / n)],
  };
}

function nearestJunctionIndex(x, y) {
  let best = 0;
  let bestDist = Infinity;
  const n = ROAD_POSITIONS.length;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const dx = x - ROAD_POSITIONS[ix];
      const dy = y - ROAD_POSITIONS[iy];
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = junctionIndex(ix, iy);
      }
    }
  }
  return best;
}

// Breadth-first route across the junction graph. The returned list
// always starts with the junction nearest the start point, so the car
// drives along its own road to the first junction instead of cutting
// diagonally across a block.
export function findRoute(fromX, fromY, toX, toY) {
  const n = ROAD_POSITIONS.length;
  const start = nearestJunctionIndex(fromX, fromY);
  const goal = nearestJunctionIndex(toX, toY);
  if (start === goal) {
    const j = junctionCoords(goal);
    return [j];
  }
  const parent = new Array(n * n).fill(-1);
  const seen = new Array(n * n).fill(false);
  const queue = [start];
  seen[start] = true;
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === goal) break;
    const cx = cur % n;
    const cy = Math.floor(cur / n);
    const neighbours = [];
    if (cx > 0) neighbours.push(junctionIndex(cx - 1, cy));
    if (cx < n - 1) neighbours.push(junctionIndex(cx + 1, cy));
    if (cy > 0) neighbours.push(junctionIndex(cx, cy - 1));
    if (cy < n - 1) neighbours.push(junctionIndex(cx, cy + 1));
    for (const nb of neighbours) {
      if (!seen[nb]) {
        seen[nb] = true;
        parent[nb] = cur;
        queue.push(nb);
      }
    }
  }
  const path = [];
  let cur = goal;
  let guard = 0;
  while (cur !== -1 && guard < n * n + 4) {
    path.unshift(junctionCoords(cur));
    if (cur === start) break;
    cur = parent[cur];
    guard++;
  }
  if (path.length === 0) return [junctionCoords(goal)];
  return path;
}

export function isOnRoad(x, y) {
  const p = nearestRoadPoint(x, y);
  return p && p.dist <= ON_ROAD_TOLERANCE;
}

export function pickCarColor(type, rng) {
  const spec = CAR_TYPES[type] || CAR_TYPES.sedan;
  const colors = spec.colors;
  if (typeof rng === 'function') {
    return colors[Math.floor(rng() * colors.length) % colors.length];
  }
  return colors[Math.floor(Math.random() * colors.length)];
}

// --- Car creation ------------------------------------------------------

export function createCar(type, x, y, opts = {}) {
  const spec = CAR_TYPES[type] || CAR_TYPES.sedan;
  const car = {
    id: opts.id != null ? opts.id : nextCarId++,
    type,
    name: spec.name,
    x,
    y,
    angle: opts.angle != null ? opts.angle : 0,
    speed: 0,
    topSpeed: spec.topSpeed,
    accel: spec.accel,
    brake: spec.brake,
    turn: spec.turn,
    color: opts.color || pickCarColor(type, opts.rng),
    health: 100,
    maxHealth: 100,
    isPlayer: !!opts.isPlayer,
    parked: !!opts.parked,
    hasDriver: opts.hasDriver !== false,
    cruiseSpeed: opts.cruiseSpeed != null ? opts.cruiseSpeed : spec.topSpeed,
    route: null,
    routeIndex: 0,
    routeDestination: null,
    routeFixed: false,
    finalLeg: false,
    rotating: false,
    rotateTarget: 0,
    reversing: false,
    reverseTimer: 0,
    stuckTimer: 0,
    lastProgressX: x,
    lastProgressY: y,
    wallDamageTimer: 0,
    smoke: false,
    skidMarks: [],
    handbrake: false,
    upgrades: { engine: 0, armor: 0, tires: 0, brakes: 0 },
    paintColor: null,
    // Debug readouts for probes (harmless, written every frame).
    _dbgSteer: 0,
    _dbgWant: 0,
    _dbgDiff: 0,
  };
  applyUpgrades(car);
  return car;
}

// Upgrade levels live on the car; engine raises top speed, tires raise
// turn authority, brakes shorten stopping distance.
export function applyUpgrades(car) {
  const spec = CAR_TYPES[car.type] || CAR_TYPES.sedan;
  car.topSpeed = spec.topSpeed + car.upgrades.engine * 40;
  car.accel = spec.accel + car.upgrades.engine * 30;
  car.brake = spec.brake + car.upgrades.brakes * 90;
  car.turn = spec.turn + car.upgrades.tires * 0.35;
  if (car.cruiseSpeed > car.topSpeed) car.cruiseSpeed = car.topSpeed;
  return car;
}

// --- Route handling ----------------------------------------------------

export function setCarRoute(car, targetX, targetY, opts = {}) {
  const fixed = !!opts.fixed;
  car.route = findRoute(car.x, car.y, targetX, targetY);
  car.routeIndex = 0;
  car.routeDestination = { x: targetX, y: targetY };
  car.routeFixed = fixed;
  car.finalLeg = false;
  return car.route;
}

// A route goes stale when its target moved well away from the
// destination the route was recorded for — rebuild, never every frame.
export function routeNeedsRebuild(car, targetX, targetY) {
  if (!car.route || !car.routeDestination) return true;
  const dx = targetX - car.routeDestination.x;
  const dy = targetY - car.routeDestination.y;
  return Math.sqrt(dx * dx + dy * dy) > 100;
}

// The car's current steering aim: the next waypoint on its route, or
// the raw target when it has no route. Once the final junction is
// reached, a fixed landmark gets a straight final leg to its exact
// point; a moving target never gets that leg.
export function currentAimPoint(car, target) {
  if (car.route && car.routeIndex < car.route.length) {
    return car.route[car.routeIndex];
  }
  if (car.routeFixed && car.routeDestination) return car.routeDestination;
  if (target) return { x: target.x, y: target.y };
  return null;
}

// --- Driving -----------------------------------------------------------

// One physics step. `control` is { throttle, steer, brake, handbrake }
// for manual driving; when a route target is given and no manual
// control is active, the car steers itself along the route.
export function updateCar(car, dt, world, target, control) {
  if (dt <= 0) return car;
  if (dt > 0.05) dt = 0.05;

  const blocked = world && typeof world.isBlocked === 'function'
    ? (x, y) => world.isBlocked(x, y)
    : null;

  // --- Route bookkeeping ---------------------------------------------
  if (target) {
    if (routeNeedsRebuild(car, target.x, target.y)) {
      setCarRoute(car, target.x, target.y, { fixed: !!target.fixed });
    }
  }
  if (car.route && car.routeIndex < car.route.length) {
    const wp = car.route[car.routeIndex];
    const dx = wp.x - car.x;
    const dy = wp.y - car.y;
    if (Math.sqrt(dx * dx + dy * dy) < WAYPOINT_REACH) {
      car.routeIndex++;
      if (car.routeIndex >= car.route.length && car.routeFixed) {
        car.finalLeg = true;
      }
    }
  }

  // --- Off-road recovery ---------------------------------------------
  // A car that ended up off the roads drives back to the nearest road
  // point, then to the nearest junction — never at a centreline point
  // outside the world edge.
  let aim = currentAimPoint(car, target);
  if (!car.parked && !isOnRoad(car.x, car.y) && !car.finalLeg) {
    const roadPt = nearestRoadPoint(car.x, car.y);
    const junction = nearestJunction(car.x, car.y);
    const onRoadNow = Math.abs(car.x - roadPt.x) < 4 || Math.abs(car.y - roadPt.y) < 4;
    aim = onRoadNow ? junction : roadPt;
  }
  if (car.finalLeg && car.routeDestination) aim = car.routeDestination;

  // --- Desired speed ---------------------------------------------------
  let desiredSpeed = car.cruiseSpeed;
  let wantAngle = car.angle;
  if (aim) {
    wantAngle = Math.atan2(aim.y - car.y, aim.x - car.x);
    const diff = Math.abs(angleDifference(car.angle, wantAngle));
    car._dbgDiff = diff;
    // Brake ahead of a sharp turn, and crawl through U-turns.
    if (diff > U_TURN_ANGLE) desiredSpeed = Math.min(desiredSpeed, 60);
    else if (diff > SHARP_TURN_ANGLE) desiredSpeed = Math.min(desiredSpeed, 180);
    else if (diff > 0.5) desiredSpeed = Math.min(desiredSpeed, 300);
    // Slow near the next waypoint so the turn is not overshot.
    if (car.route && car.routeIndex < car.route.length) {
      const wp = car.route[car.routeIndex];
      const d = distanceBetween(car, wp);
      if (d < 380 && diff > 0.5) desiredSpeed = Math.min(desiredSpeed, 300);
      if (d < 220 && diff > SHARP_TURN_ANGLE) desiredSpeed = Math.min(desiredSpeed, 180);
    }
    if (car.route && car.routeIndex >= car.route.length && car.finalLeg) {
      const d = distanceBetween(car, car.routeDestination);
      if (d < 120) desiredSpeed = Math.min(desiredSpeed, 120);
    }
    // Crawl while creeping up on a waypoint.
    if (car.route && car.routeIndex < car.route.length) {
      const wp = car.route[car.routeIndex];
      if (distanceBetween(car, wp) < CRAWL_NEAR_WAYPOINT) {
        desiredSpeed = Math.min(desiredSpeed, 120);
      }
    }
  }

  // Manual control overrides the autopilot's desired speed.
  let steerInput = 0;
  if (control) {
    if (control.throttle > 0) desiredSpeed = car.topSpeed;
    else if (control.throttle < 0) desiredSpeed = -car.topSpeed * 0.45;
    else if (control.brake) desiredSpeed = 0;
    steerInput = control.steer || 0;
    car.handbrake = !!control.handbrake;
  }

  // --- Stop and rotate in place ---------------------------------------
  // A turn sharper than ~52 degrees cannot be taken while moving: the
  // turning circle is wider than the 64-wide road. Stop fully, rotate
  // in place, then drive straight. Traffic cars do the same, so they
  // pause briefly at junctions — it looks deliberate.
  const angleDiff = aim ? angleDifference(car.angle, wantAngle) : 0;
  if (!control && aim && Math.abs(angleDiff) > SHARP_TURN_ANGLE && !car.reversing) {
    car.rotating = true;
    car.rotateTarget = wantAngle;
  }
  if (car.rotating) {
    car.speed = 0;
    const step = 3.2 * dt;
    const remaining = angleDifference(car.angle, car.rotateTarget);
    if (Math.abs(remaining) <= step) {
      car.angle = car.rotateTarget;
      car.rotating = false;
    } else {
      car.angle += Math.sign(remaining) * step;
    }
    car._dbgSteer = 0;
    return car;
  }
  car.rotating = false;

  // --- Stuck detection: reverse straight to unwedge --------------------
  const moved = distanceBetween(car, { x: car.lastProgressX, y: car.lastProgressY });
  if (!car.parked && Math.abs(desiredSpeed) > 20 && Math.abs(car.speed) < STUCK_SPEED) {
    car.stuckTimer += dt;
  } else {
    car.stuckTimer = 0;
    car.lastProgressX = car.x;
    car.lastProgressY = car.y;
  }
  if (car.stuckTimer > STUCK_TIME && !car.reversing) {
    car.reversing = true;
    car.reverseTimer = REVERSE_UNWEDGE_TIME;
    car.stuckTimer = 0;
  }
  if (car.reversing) {
    car.reverseTimer -= dt;
    car.speed = Math.max(car.speed - car.accel * dt, -120);
    const nx = car.x + Math.cos(car.angle) * car.speed * dt;
    const ny = car.y + Math.sin(car.angle) * car.speed * dt;
    moveCarWithSlide(car, nx, ny, blocked);
    if (car.reverseTimer <= 0) {
      car.reversing = false;
      car.speed = 0;
      car.lastProgressX = car.x;
      car.lastProgressY = car.y;
    }
    return car;
  }

  // --- Speed ------------------------------------------------------------
  if (car.handbrake) {
    car.speed -= Math.sign(car.speed) * car.brake * 1.6 * dt;
    if (Math.abs(car.speed) < 8) car.speed = 0;
  } else if (car.speed < desiredSpeed) {
    car.speed = Math.min(car.speed + car.accel * dt, desiredSpeed);
  } else if (car.speed > desiredSpeed) {
    const decel = control && control.brake ? car.brake : car.brake * 0.55;
    car.speed = Math.max(car.speed - decel * dt, desiredSpeed);
  }
  if (car.speed > car.topSpeed) car.speed = car.topSpeed;

  // --- Steering (radius-based) ------------------------------------------
  let steer = steerInput;
  if (!control && aim) {
    steer = clamp(angleDiff * 2.2, -1, 1);
  }
  car._dbgSteer = steer;
  const speedAbs = Math.abs(car.speed);
  if (steer !== 0 && speedAbs > 0.5) {
    // Radius-based: turn rate = speed / radius, radius grows with
    // speed. A minimum turn rate is guaranteed even at low speed, and
    // crawl-forward turns are allowed.
    const radius = TURN_RADIUS_BASE + TURN_RADIUS_SPEED * speedAbs;
    let turnRate = speedAbs / radius;
    if (turnRate < MIN_TURN_RATE * 0.35) turnRate = MIN_TURN_RATE * 0.35;
    turnRate = Math.min(turnRate, car.turn);
    car.angle += steer * turnRate * dt * Math.sign(car.speed);
  } else if (steer !== 0 && speedAbs <= 0.5 && !car.parked) {
    // Crawl-forward turn: creep forward while turning at very low speed.
    car.angle += steer * MIN_TURN_RATE * 0.5 * dt;
    car.speed = Math.max(car.speed, 24);
  }

  // --- Move, sliding along walls instead of sticking --------------------
  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  moveCarWithSlide(car, nx, ny, blocked);

  // --- Skid marks ---------------------------------------------------------
  if ((car.handbrake && speedAbs > 120) || (Math.abs(steer) > 0.8 && speedAbs > 260)) {
    car.skidMarks.push({ x: car.x, y: car.y, angle: car.angle, life: 1.6 });
    if (car.skidMarks.length > MAX_SKID_MARKS) car.skidMarks.shift();
  }
  for (let i = car.skidMarks.length - 1; i >= 0; i--) {
    car.skidMarks[i].life -= dt;
    if (car.skidMarks[i].life <= 0) car.skidMarks.splice(i, 1);
  }

  car.wallDamageTimer = Math.max(0, car.wallDamageTimer - dt);
  car.smoke = car.health < SMOKE_HEALTH;
  return car;
}

// Move to (nx, ny); on a blocked step, slide along the wall by trying
// each axis on its own instead of stopping dead. Wall damage ticks at
// most once per 0.5 s.
function moveCarWithSlide(car, nx, ny, blocked) {
  const hitWall = (x, y) => {
    if (x < 24 || x > WORLD_W - 24 || y < 24 || y > WORLD_H - 24) return true;
    if (blocked && blocked(x, y)) return true;
    return false;
  };
  const tryX = !hitWall(nx, car.y);
  const tryY = !hitWall(car.x, ny);
  let bumped = false;
  if (tryX) car.x = clamp(nx, 24, WORLD_W - 24);
  else bumped = true;
  if (tryY) car.y = clamp(ny, 24, WORLD_H - 24);
  else bumped = true;
  if (bumped && Math.abs(car.speed) > 60) {
    if (car.wallDamageTimer <= 0) {
      damageCar(car, 3);
      car.wallDamageTimer = WALL_DAMAGE_INTERVAL;
    }
    car.speed *= 0.55;
  }
}

export function damageCar(car, amount) {
  const resistance = 1 - car.upgrades.armor * 0.15;
  car.health = Math.max(0, car.health - amount * Math.max(0.25, resistance));
  car.smoke = car.health < SMOKE_HEALTH;
  return car.health;
}

export function repairCar(car, amount) {
  car.health = Math.min(car.maxHealth, car.health + amount);
  car.smoke = car.health < SMOKE_HEALTH;
  return car.health;
}

export function isCarWrecked(car) {
  return car.health <= 0;
}

// Keep two cars from overlapping: push them apart along the line
// between them. The player's car is never pushed by this separation.
export function separateCars(a, b, minDist = 46) {
  if (a.isPlayer || b.isPlayer) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= 0.01 || d >= minDist) return;
  const push = (minDist - d) / 2;
  const ux = dx / d;
  const uy = dy / d;
  a.x -= ux * push;
  a.y -= uy * push;
  b.x += ux * push;
  b.y += uy * push;
}

export function carDimensions(type) {
  if (type === 'truck') return { length: 54, width: 26 };
  if (type === 'sports') return { length: 44, width: 20 };
  return { length: 46, width: 22 };
}

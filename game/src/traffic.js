// traffic.js — cars, the road graph, and radius-based driving (Crescent Bay).
//
// Owns everything with four wheels: the car types (sedan / taxi / truck /
// sports / police) with different top speeds and acceleration, parked cars,
// traffic that follows the road graph and slows behind the car ahead, the
// shared driving core every driver uses (autopilot, traffic AI, manual
// driving through applyCarPhysics), route-finding on the junction graph,
// off-road recovery, wall sliding, and car-to-car separation.
//
// Road geometry comes straight from the spec: the world is 3200x3200, an
// 8x8 grid of roads at 200 + i*400, each 64 wide. Routes are found by BFS
// over the junction graph and ALWAYS include the first junction as the
// first waypoint, so a car never cuts diagonally across a block.
//
// Steering rules built in from the start (all proven in earlier builds):
// steering is radius-based so cars turn inside 64-wide roads; slow down
// before sharp junction turns; a car that must turn sharper than ~52
// degrees (|angle diff| > 0.9) STOPS fully and rotates in place, then
// drives straight; U-turns crawl at speed 60; when stuck, reverse
// straight to unwedge; wall collisions slide instead of sticking; wall
// damage ticks at most once per 0.5s; a minimum turn authority holds even
// at low speed and crawl-forward turns are allowed; off-road cars recover
// to the nearest road, then to the nearest junction (never aim at a
// centreline point outside the world edge); a route is rebuilt only when
// its target moves more than 100 from the route's recorded destination.
//
// Car object shape (plain objects, shared with the rest of the game):
//   { x, y, angle, speed, type, topSpeed, accel, color, length, width,
//     parked, driver: 'traffic' | 'player' | null, player: bool,
//     health, wrecked, route: [{x,y}], routeDest: {x,y} | null,
//     cruise, stuckT, reverseT, recover, lastWallDamageT,
//     upgrades: { engine, armor, tires, brakes } }

export const CAR_TYPES = {
  sedan: {
    topSpeed: 380, accel: 430, brake: 900, length: 46, width: 22,
    colors: ['#b8442e', '#3e6fb0', '#7a7f85', '#4f8a4a', '#c9a227', '#8a5a9e'],
  },
  taxi: {
    topSpeed: 400, accel: 460, brake: 900, length: 46, width: 22,
    colors: ['#f5c518', '#f5c518', '#ffd94d'],
  },
  truck: {
    topSpeed: 330, accel: 300, brake: 750, length: 58, width: 24,
    colors: ['#6b7280', '#9a6b3f', '#4a6741', '#7d8a96'],
  },
  sports: {
    topSpeed: 520, accel: 660, brake: 1000, length: 44, width: 22,
    colors: ['#e01e37', '#f5c518', '#1fa2e0', '#e07b1f', '#c0c8d0'],
  },
  police: {
    topSpeed: 540, accel: 620, brake: 1000, length: 46, width: 22,
    colors: ['#20242c'],
  },
};

export const WORLD_SIZE = 3200;
export const ROAD_COORDS = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
export const ROAD_WIDTH = 64;
export const ON_ROAD_TOL = 42;
export const WAYPOINT_RADIUS = 70;
export const SHARP_TURN_DIFF = 0.9;
export const U_TURN_DIFF = 2.6;
export const U_TURN_SPEED = 60;
export const WALL_DAMAGE_INTERVAL = 0.5;
export const WALL_DAMAGE_PER_TICK = 1.5;
export const ROUTE_REBUILD_DISTANCE = 100;
export const TRAFFIC_TARGET_COUNT = 16;
export const PARKED_TARGET_COUNT = 9;

let nextCarId = 1;

export function angDiff(target, current) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function nearestJunction(x, y) {
  const i = clamp(Math.round((x - 200) / 400), 0, 7);
  const j = clamp(Math.round((y - 200) / 400), 0, 7);
  return { x: 200 + i * 400, y: 200 + j * 400, i, j };
}

export function nearestRoadPoint(x, y) {
  let best = null, bestD = Infinity;
  for (const c of ROAD_COORDS) {
    const cy = clamp(y, 40, WORLD_SIZE - 40);
    const d1 = Math.hypot(c - x, cy - y);
    if (d1 < bestD) { bestD = d1; best = { x: c, y: cy }; }
    const cx = clamp(x, 40, WORLD_SIZE - 40);
    const d2 = Math.hypot(cx - x, c - y);
    if (d2 < bestD) { bestD = d2; best = { x: cx, y: c }; }
  }
  return best;
}

export function distanceToRoad(x, y) {
  let nearest = Infinity;
  for (const c of ROAD_COORDS) {
    nearest = Math.min(nearest, Math.abs(x - c), Math.abs(y - c));
  }
  return nearest;
}

export function isOnRoad(x, y) {
  return distanceToRoad(x, y) <= ON_ROAD_TOL;
}

export function worldBlocked(world, x, y) {
  if (x < 24 || x > WORLD_SIZE - 24 || y < 24 || y > WORLD_SIZE - 24) return true;
  if (world && typeof world.isBlocked === 'function') return world.isBlocked(x, y);
  // Fallback from spec geometry: off the carriageway and sidewalk, a
  // point is inside a block and blocked.
  return distanceToRoad(x, y) > 44;
}

// BFS over the 8x8 junction graph. The returned waypoints ALWAYS start
// with the junction nearest the start point (never a diagonal cut across
// a block), then follow the grid to the junction nearest the target.
// For a fixed landmark, opts.finalLeg appends the exact target point as
// the last leg; moving targets never get a final leg.
export function buildRoute(fromX, fromY, toX, toY, opts = {}) {
  const start = nearestJunction(fromX, fromY);
  const end = nearestJunction(toX, toY);
  const key = (i, j) => j * 8 + i;
  const prev = new Map();
  const seen = new Set([key(start.i, start.j)]);
  const queue = [[start.i, start.j]];
  while (queue.length) {
    const [ci, cj] = queue.shift();
    if (ci === end.i && cj === end.j) break;
    const neighbours = [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]];
    for (const [ni, nj] of neighbours) {
      if (ni < 0 || ni > 7 || nj < 0 || nj > 7) continue;
      const k = key(ni, nj);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, key(ci, cj));
      queue.push([ni, nj]);
    }
  }
  // Walk the parent chain back from the end junction.
  const path = [];
  let cur = key(end.i, end.j);
  let guard = 0;
  while (cur !== undefined && guard++ < 64) {
    const j = Math.floor(cur / 8), i = cur % 8;
    path.unshift({ x: 200 + i * 400, y: 200 + j * 400 });
    if (cur === key(start.i, start.j)) break;
    cur = prev.get(cur);
  }
  if (path.length === 0 || path[0].x !== start.x || path[0].y !== start.y) {
    path.unshift({ x: start.x, y: start.y });
  }
  if (opts.finalLeg) {
    const last = path[path.length - 1];
    if (Math.hypot(toX - last.x, toY - last.y) > 30) {
      path.push({ x: toX, y: toY });
    }
  }
  return path;
}

export function effectiveTopSpeed(car) {
  const base = car.topSpeed || 380;
  const engine = (car.upgrades && car.upgrades.engine) || 0;
  return base * (1 + 0.12 * engine);
}

export function effectiveAccel(car) {
  const base = car.accel || 430;
  const engine = (car.upgrades && car.upgrades.engine) || 0;
  return base * (1 + 0.1 * engine);
}

export function effectiveBrake(car) {
  const base = (CAR_TYPES[car.type] && CAR_TYPES[car.type].brake) || 900;
  const brakes = (car.upgrades && car.upgrades.brakes) || 0;
  return base * (1 + 0.15 * brakes);
}

export function damageCar(car, amount) {
  const armor = (car.upgrades && car.upgrades.armor) || 0;
  const taken = amount * (1 - 0.15 * armor);
  car.health = Math.max(0, (car.health ?? 100) - taken);
  if (car.health <= 0 && !car.wrecked) {
    car.wrecked = true;
    car.speed = 0;
  }
  return taken;
}

export function createCar(x, y, type = 'sedan', opts = {}) {
  const def = CAR_TYPES[type] || CAR_TYPES.sedan;
  const colors = def.colors;
  const color = opts.color || colors[Math.floor(Math.random() * colors.length)];
  return {
    id: nextCarId++,
    x, y,
    angle: opts.angle !== undefined ? opts.angle : Math.random() * Math.PI * 2,
    speed: 0,
    type,
    topSpeed: def.topSpeed * (0.95 + Math.random() * 0.1),
    accel: def.accel,
    color,
    length: def.length,
    width: def.width,
    parked: !!opts.parked,
    driver: opts.driver || null,
    player: false,
    health: 100,
    maxHealth: 100,
    wrecked: false,
    route: [],
    routeDest: null,
    cruise: opts.cruise || 320,
    stuckT: 0,
    reverseT: 0,
    recover: false,
    uturn: false,
    lastWallDamageT: -10,
    upgrades: { engine: 0, armor: 0, tires: 0, brakes: 0 },
  };
}

// Radius-based car physics shared by manual driving, traffic AI and the
// autopilot. throttle -1..1, steer -1..1, handbrake tightens the turn.
export function applyCarPhysics(car, ctrl, dt, world, now = 0) {
  if (!car || car.wrecked) return;
  const throttle = clamp(ctrl.throttle || 0, -1, 1);
  const steer = clamp(ctrl.steer || 0, -1, 1);
  const top = effectiveTopSpeed(car);

  if (throttle > 0) {
    car.speed += effectiveAccel(car) * throttle * dt;
  } else if (throttle < 0) {
    if (car.speed > 12) car.speed -= effectiveBrake(car) * dt;
    else car.speed -= effectiveAccel(car) * 0.55 * dt;
  } else {
    car.speed -= car.speed * 0.4 * dt;
  }
  if (ctrl.handbrake) {
    car.speed *= Math.max(0, 1 - 3.2 * dt);
  }
  car.speed = clamp(car.speed, -140, top);

  // Radius-based steering: turn rate = speed / radius, radius grows
  // with speed. A minimum turn authority holds even at low speed, and
  // a car creeping forward while steering can still turn.
  const tires = (car.upgrades && car.upgrades.tires) || 0;
  let radius = (80 + 0.3 * Math.abs(car.speed)) * (1 - 0.08 * tires);
  if (ctrl.handbrake) radius *= 0.6;
  let turnRate = car.speed / Math.max(40, radius);
  if (Math.abs(steer) > 0.15 && Math.abs(car.speed) < 40) {
    // Crawl-forward turn: keep at least a creeping speed while turning.
    if (car.speed >= 0) car.speed = Math.max(car.speed, 30);
    else car.speed = Math.min(car.speed, -30);
    turnRate = car.speed / Math.max(40, radius);
    const minAuthority = 0.55;
    if (Math.abs(turnRate) < minAuthority) {
      turnRate = Math.sign(turnRate || steer) * minAuthority;
    }
  }
  car.angle += turnRate * steer * dt;

  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  if (!worldBlocked(world, nx, ny)) {
    car.x = nx; car.y = ny;
  } else if (!worldBlocked(world, nx, car.y)) {
    // Slide along the wall on the x axis.
    car.x = nx;
    car.speed *= 0.55;
    wallDamageTick(car, now);
  } else if (!worldBlocked(world, car.x, ny)) {
    car.y = ny;
    car.speed *= 0.55;
    wallDamageTick(car, now);
  } else {
    car.speed *= 0.3;
    wallDamageTick(car, now);
  }
}

function wallDamageTick(car, now) {
  if (now - (car.lastWallDamageT ?? -10) >= WALL_DAMAGE_INTERVAL) {
    car.lastWallDamageT = now;
    damageCar(car, WALL_DAMAGE_PER_TICK);
  }
}

// Drive a car toward a target point along the road graph. Returns
// { arrived, rotating, distToWaypoint, diff }. The caller picks the
// cruise speed; this function handles braking, sharp turns, stuck
// recovery and off-road recovery.
export function driveCarToward(car, tx, ty, cruise, dt, world, now = 0, opts = {}) {
  if (!car || car.wrecked) return { arrived: false, rotating: false, distToWaypoint: 0, diff: 0 };

  // Off-road recovery is sticky: keep following the recovery route
  // (nearest road point, then nearest junction) until it is done.
  if (!car.recover && !isOnRoad(car.x, car.y)) {
    car.recover = true;
    const roadPt = nearestRoadPoint(car.x, car.y);
    // A car with a poisoned position (NaN) has no nearest road
    // point; bailing out for this frame keeps one bad car from
    // throwing and killing the whole frame loop.
    if (!roadPt) return { arrived: false, rotating: false, distToWaypoint: 0, diff: 0 };
    const junction = nearestJunction(roadPt.x, roadPt.y);
    car.route = [roadPt, { x: junction.x, y: junction.y }];
    car.routeDest = { x: tx, y: ty };
  }
  if (!car.recover) {
    const dest = car.routeDest;
    const moved = !dest || Math.hypot(tx - dest.x, ty - dest.y) > ROUTE_REBUILD_DISTANCE;
    if (!car.route.length || moved) {
      car.route = buildRoute(car.x, car.y, tx, ty, { finalLeg: !!opts.finalLeg });
      car.routeDest = { x: tx, y: ty };
    }
  }

  let waypoint = car.route[0];
  if (!waypoint) return { arrived: true, rotating: false, distToWaypoint: 0, diff: 0 };
  let distToWaypoint = Math.hypot(waypoint.x - car.x, waypoint.y - car.y);
  while (waypoint && distToWaypoint < WAYPOINT_RADIUS) {
    // The last waypoint is only the destination's nearest junction,
    // not the destination itself. Popping it strands the car: the m2
    // chase proved it — the player's route to the courier was a
    // single junction 69 away while the courier sat 118 away, so
    // driveCarToward reported "arrived" every frame and the car
    // never moved (speed frozen at 200 for 130+ seconds, the
    // autopilot's stuck-watch clearing a route that rebuilt the
    // same way). Only pop the final waypoint once the car is also
    // within radius of the real destination. A car in off-road
    // recovery keeps the old rule: reaching its junction IS the
    // recovery finishing, and the caller then assigns a fresh route.
    if (!car.route[1] && !car.recover && Math.hypot(tx - car.x, ty - car.y) >= WAYPOINT_RADIUS) break;
    car.route.shift();
    waypoint = car.route[0];
    if (waypoint) distToWaypoint = Math.hypot(waypoint.x - car.x, waypoint.y - car.y);
  }
  if (!waypoint) {
    car.recover = false;
    car.routeDest = null;
    return { arrived: true, rotating: false, distToWaypoint: 0, diff: 0 };
  }

  const desired = Math.atan2(waypoint.y - car.y, waypoint.x - car.x);
  const diff = angDiff(desired, car.angle);

  // Sharp turn ahead on the route: brake early.
  let targetSpeed = cruise;
  if (distToWaypoint < 170) targetSpeed = Math.min(targetSpeed, 120);
  const next = car.route[1];
  if (next) {
    const turnAngle = Math.abs(angDiff(
      Math.atan2(next.y - waypoint.y, next.x - waypoint.x),
      Math.atan2(waypoint.y - car.y, waypoint.x - car.x),
    ));
    if (turnAngle > SHARP_TURN_DIFF) {
      if (distToWaypoint < 220) targetSpeed = Math.min(targetSpeed, 180);
      else if (distToWaypoint < 380) targetSpeed = Math.min(targetSpeed, 300);
    }
  }

  // A turn sharper than ~52 degrees: STOP fully and rotate in place.
  // A moving turning circle is wider than the 64-wide road.
  if (Math.abs(diff) > SHARP_TURN_DIFF) {
    if (Math.abs(diff) > U_TURN_DIFF) car.uturn = true;
    if (Math.abs(car.speed) > 6) {
      applyCarPhysics(car, { throttle: -1, steer: 0 }, dt, world, now);
    } else {
      car.speed = 0;
      car.angle += clamp(diff, -1, 1) * 2.4 * dt;
    }
    return { arrived: false, rotating: true, distToWaypoint, diff };
  }
  if (car.uturn) targetSpeed = Math.min(targetSpeed, U_TURN_SPEED);
  if (distToWaypoint > WAYPOINT_RADIUS + 60) car.uturn = false;

  // Stuck: reversing straight unwedges the car.
  if (car.reverseT > 0) {
    car.reverseT -= dt;
    applyCarPhysics(car, { throttle: -1, steer: 0 }, dt, world, now);
    return { arrived: false, rotating: false, distToWaypoint, diff };
  }
  if (Math.abs(car.speed) < 12 && targetSpeed > 40) {
    car.stuckT += dt;
    if (car.stuckT > 1.5) {
      car.stuckT = 0;
      car.reverseT = 0.9;
    }
  } else {
    car.stuckT = 0;
  }

  let throttle = 0;
  if (car.speed < targetSpeed) throttle = 1;
  else if (car.speed > targetSpeed + 12) throttle = -0.6;
  const steer = clamp(diff * 1.8, -1, 1);
  applyCarPhysics(car, { throttle, steer }, dt, world, now);
  return { arrived: false, rotating: false, distToWaypoint, diff };
}

// Follow a MOVING target (the courier in the tail chase): rebuild the
// route only when the target moves more than 100 from the route's
// recorded destination — never every frame.
export function followMovingTarget(car, target, cruise, dt, world, now = 0) {
  // A moving target's nearest junction is often the chaser's nearest
  // junction too, so the route can be a single junction waypoint that
  // pops while the target is still 100+ away. Close in, append the
  // target's exact position as the final leg so the car closes on the
  // target itself, not its junction.
  const close = Math.hypot(target.x - car.x, target.y - car.y) < 600;
  return driveCarToward(car, target.x, target.y, cruise, dt, world, now, { finalLeg: close });
}

function randomJunctionPoint() {
  const i = Math.floor(Math.random() * 8);
  const j = Math.floor(Math.random() * 8);
  return { x: 200 + i * 400, y: 200 + j * 400 };
}

function randomRoadPointNear(game, minDist, maxDist) {
  const p = game.player;
  for (let tries = 0; tries < 12; tries++) {
    const rc = ROAD_COORDS[Math.floor(Math.random() * ROAD_COORDS.length)];
    const along = 200 + Math.random() * 2800;
    const vertical = Math.random() < 0.5;
    const pt = vertical ? { x: rc, y: along } : { x: along, y: rc };
    const d = p ? Math.hypot(pt.x - p.x, pt.y - p.y) : 600;
    if (d >= minDist && d <= maxDist) return pt;
  }
  return { x: 1400, y: 1400 };
}

export function findNearestParkedCar(game, x, y, minTopSpeed = 0) {
  let best = null, bestD = Infinity;
  for (const car of game.cars || []) {
    if (!car || !car.parked || car.wrecked || car.player) continue;
    if (effectiveTopSpeed(car) < minTopSpeed) continue;
    const d = Math.hypot(car.x - x, car.y - y);
    if (d < bestD) { bestD = d; best = car; }
  }
  return best ? { car: best, dist: bestD } : null;
}

export function findNearestCar(game, x, y, filter) {
  let best = null, bestD = Infinity;
  for (const car of game.cars || []) {
    if (!car || car.wrecked) continue;
    if (filter && !filter(car)) continue;
    const d = Math.hypot(car.x - x, car.y - y);
    if (d < bestD) { bestD = d; best = car; }
  }
  return best ? { car: best, dist: bestD } : null;
}

function carAheadOf(game, car, maxDist) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  let best = null, bestProj = Infinity;
  for (const other of game.cars || []) {
    if (!other || other === car || other.wrecked) continue;
    const rx = other.x - car.x, ry = other.y - car.y;
    const proj = rx * fx + ry * fy;
    if (proj <= 0 || proj > maxDist) continue;
    const lateral = Math.abs(rx * fy - ry * fx);
    if (lateral > 32) continue;
    if (proj < bestProj) { bestProj = proj; best = other; }
  }
  return best ? { car: best, proj: bestProj } : null;
}

export function separateCars(game) {
  const cars = game.cars || [];
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    if (!a || a.wrecked) continue;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      if (!b || b.wrecked) continue;
      // Separation skips the player's car: it must not be shoved out
      // of the Spray Shop radius by traffic.
      if (a.player || b.player) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const minD = (a.length + b.length) / 2 - 6;
      if (d > 0.01 && d < minD) {
        const push = (minD - d) / 2;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
      }
    }
  }
}

function spawnTrafficCar(game) {
  const types = ['sedan', 'sedan', 'taxi', 'sedan', 'truck', 'sports', 'taxi'];
  const type = types[Math.floor(Math.random() * types.length)];
  const pt = randomRoadPointNear(game, 500, 950);
  const car = createCar(pt.x, pt.y, type, {
    driver: 'traffic',
    angle: Math.random() < 0.5 ? 0 : Math.PI / 2,
    cruise: 280 + Math.random() * 80,
  });
  const dest = randomJunctionPoint();
  car.route = buildRoute(car.x, car.y, dest.x, dest.y);
  car.routeDest = dest;
  game.cars.push(car);
  return car;
}

function spawnParkedCar(game) {
  const types = ['sedan', 'sedan', 'taxi', 'truck', 'sports', 'sedan'];
  const type = types[Math.floor(Math.random() * types.length)];
  const rc = ROAD_COORDS[Math.floor(Math.random() * ROAD_COORDS.length)];
  const along = 260 + Math.random() * 2680;
  const side = Math.random() < 0.5 ? -1 : 1;
  const vertical = Math.random() < 0.5;
  const x = vertical ? rc + side * 46 : along;
  const y = vertical ? along : rc + side * 46;
  const angle = vertical ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : (side > 0 ? 0 : Math.PI);
  const car = createCar(x, y, type, { parked: true, angle });
  game.cars.push(car);
  return car;
}

export function updateTraffic(game, dt) {
  if (!game.cars) game.cars = [];
  const now = game.now || 0;
  const hour = game.hour !== undefined ? game.hour : 12;
  const density = (hour >= 10 && hour <= 16) ? 1 : (hour >= 22 || hour < 6) ? 0.5 : 0.75;
  const trafficTarget = Math.round(TRAFFIC_TARGET_COUNT * density);
  const p = game.player;

  // Spawn / despawn traffic around the player.
  let trafficCount = 0;
  for (let i = game.cars.length - 1; i >= 0; i--) {
    const car = game.cars[i];
    if (!car) continue;
    if (car.driver === 'traffic') {
      trafficCount++;
      if (p && Math.hypot(car.x - p.x, car.y - p.y) > 1100) {
        game.cars.splice(i, 1);
        trafficCount--;
      }
    } else if (car.parked && !car.player) {
      if (p && Math.hypot(car.x - p.x, car.y - p.y) > 1300) {
        game.cars.splice(i, 1);
      }
    }
  }
  while (trafficCount < trafficTarget) {
    spawnTrafficCar(game);
    trafficCount++;
  }

  // Keep parked cars available near the player.
  let parkedCount = 0;
  for (const car of game.cars) if (car && car.parked && !car.player) parkedCount++;
  while (parkedCount < PARKED_TARGET_COUNT) {
    spawnParkedCar(game);
    parkedCount++;
  }

  // Drive every traffic car.
  for (const car of game.cars) {
    if (!car || car.driver !== 'traffic' || car.wrecked) continue;
    if (!car.route.length) {
      const dest = randomJunctionPoint();
      car.route = buildRoute(car.x, car.y, dest.x, dest.y);
      car.routeDest = dest;
    }
    let cruise = car.cruise || 320;
    const ahead = carAheadOf(game, car, 110);
    if (ahead) {
      // Slow behind the car ahead; stop if it is nearly stopped.
      cruise = Math.min(cruise, Math.max(0, ahead.car.speed - 10));
      if (ahead.proj < 55) cruise = 0;
    }
    const dest = car.routeDest || { x: car.x, y: car.y };
    const res = driveCarToward(car, dest.x, dest.y, cruise, dt, game.world, now, { finalLeg: false });
    if (res.arrived) {
      const next = randomJunctionPoint();
      car.route = buildRoute(car.x, car.y, next.x, next.y);
      car.routeDest = next;
    }
  }

  separateCars(game);
}

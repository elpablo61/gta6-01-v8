// traffic.js — Crescent Bay civilian traffic (fresh from prose spec §1, §3.6).
//
// Civilian cars drive the 8x8 road grid (roads at 200 + i*400, width 64,
// world 3200x3200). Each car picks a route junction by junction, slows
// behind the car ahead in its lane, and brakes for sharp turns. Density
// varies by time of day: busier at midday, quieter at night (spec §3.6).
//
// Traffic cars are carjackable: the player (or autopilot) can take one,
// its driver flees on foot as a pedestrian. Parked cars sit at the road
// edge and are stealable too.
//
// This module owns its own tiny route helper over the junction grid so it
// never depends on another module's internals: junctions are indexed
// [col][row] consistently (the transposed-index infinite loop from the
// v4 builder-1 notes is designed out here — every index pair is built
// and read the same way).
//
// Context object G (only what this module reads):
//   G.rng        — function () => [0,1); falls back to a local mulberry32
//   G.timeOfDay  — 0..24, drives the density curve
//   G.player     — { x, y, car } (used only to keep traffic clear of the
//                  player's car when spawning)
//   G.onDriverFlee(x, y, color) — optional hook; the pedestrians module
//                  normally supplies it so a carjacked driver appears
//                  on the sidewalk and runs away
//   G.onTrafficCrash(car, other) — optional hook for SFX / heat
//
// Public API (returned by createTraffic):
//   update(dt)                    step all cars, spawn/despawn to target
//   draw(ctx, cam)                draw cars (top-down, 2.5D-lite shadow)
//   cars()                        live array of traffic cars
//   targetCount()                 density target for the current hour
//   nearestParked(x, y, maxDist)  nearest stealable parked car, or null
//   nearestDriven(x, y, maxDist)  nearest moving traffic car, or null
//   carjack(car)                  remove driver, hand the car to the player
//   clear()                       remove all traffic (mission reset)
//   countByType()

export const WORLD = 3200;
export const ROAD_STEP = 400;
export const ROAD_FIRST = 200;
export const ROAD_COUNT = 8;
export const ROAD_WIDTH = 64;

const CAR_TYPES = [
  { kind: 'sedan',  topSpeed: 300, accel: 220, w: 34, h: 18, weight: 1 },
  { kind: 'taxi',   topSpeed: 320, accel: 240, w: 34, h: 18, weight: 1 },
  { kind: 'truck',  topSpeed: 230, accel: 140, w: 44, h: 20, weight: 1 },
  { kind: 'sports', topSpeed: 460, accel: 340, w: 34, h: 18, weight: 1 },
];

const PAINTS = [
  '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad',
  '#ecf0f1', '#2c3e50', '#16a085', '#d35400', '#7f8c8d', '#b03a2e',
  '#1abc9c', '#d4ac0d', '#5d6d7e', '#a93226',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roadCoord(i) { return ROAD_FIRST + i * ROAD_STEP; }
function nearestRoadIndex(v) {
  const i = Math.round((v - ROAD_FIRST) / ROAD_STEP);
  return Math.max(0, Math.min(ROAD_COUNT - 1, i));
}
// Distance from v to the nearest road centreline.
function distToRoad(v) {
  const i = nearestRoadIndex(v);
  return Math.abs(v - roadCoord(i));
}

export function createTraffic(G) {
  const game = G || {};
  const rng = typeof game.rng === 'function' ? game.rng : mulberry32(20261118);
  let cars = [];
  let parked = [];
  let nextId = 1;

  // Density curve (spec §3.6): midday busy, night quiet.
  function targetCount() {
    const h = typeof game.timeOfDay === 'number' ? game.timeOfDay : 12;
    // Peak ~14 at noon, floor ~5 at 03:00.
    const dayFactor = 0.55 + 0.45 * Math.cos(((h - 12) / 24) * Math.PI * 2);
    return Math.round(5 + 9 * Math.max(0, dayFactor));
  }

  function pickType() {
    const r = rng();
    if (r < 0.12) return CAR_TYPES[3]; // sports, rare
    if (r < 0.28) return CAR_TYPES[2]; // truck
    if (r < 0.48) return CAR_TYPES[1]; // taxi
    return CAR_TYPES[0];
  }

  function pickColor() {
    return PAINTS[Math.floor(rng() * PAINTS.length)];
  }

  // A junction is (col, row) with col = x index, row = y index.
  function randomJunction() {
    return {
      col: Math.floor(rng() * ROAD_COUNT),
      row: Math.floor(rng() * ROAD_COUNT),
    };
  }

  function spawnTrafficCar() {
    const j = randomJunction();
    const dir = Math.floor(rng() * 4); // 0 E, 1 S, 2 W, 3 N
    const type = pickType();
    // Start exactly on a road, offset into the right-hand lane.
    const lane = ROAD_WIDTH / 4;
    let x = roadCoord(j.col);
    let y = roadCoord(j.row);
    if (dir === 0) y += lane;
    if (dir === 2) y -= lane;
    if (dir === 1) x -= lane;
    if (dir === 3) x += lane;
    const car = {
      id: nextId++,
      kind: type.kind,
      type,
      x, y,
      dir,
      angle: dir * Math.PI / 2,
      speed: type.topSpeed * (0.5 + rng() * 0.3),
      cruise: type.topSpeed * (0.75 + rng() * 0.25),
      color: pickColor(),
      w: type.w, h: type.h,
      parked: false,
      driver: true,
      stuck: 0,
      turnCooldown: 0,
      brake: 0,
    };
    cars.push(car);
    return car;
  }

  function spawnParkedCar() {
    const j = randomJunction();
    const horizontal = rng() < 0.5;
    const type = pickType();
    const edge = (rng() < 0.5 ? -1 : 1) * (ROAD_WIDTH / 2 + 14);
    const along = (rng() - 0.5) * 260;
    const x = horizontal ? roadCoord(j.col) + along : roadCoord(j.col) + edge;
    const y = horizontal ? roadCoord(j.row) + edge : roadCoord(j.row) + along;
    const car = {
      id: nextId++,
      kind: type.kind,
      type,
      x, y,
      dir: horizontal ? (rng() < 0.5 ? 0 : 2) : (rng() < 0.5 ? 1 : 3),
      angle: 0,
      speed: 0,
      cruise: type.topSpeed,
      color: pickColor(),
      w: type.w, h: type.h,
      parked: true,
      driver: false,
      stuck: 0,
      turnCooldown: 0,
      brake: 0,
    };
    car.angle = car.dir * Math.PI / 2;
    parked.push(car);
    return car;
  }

  function nearestJunction(x, y) {
    return { col: nearestRoadIndex(x), row: nearestRoadIndex(y) };
  }

  function atJunction(car) {
    const j = nearestJunction(car.x, car.y);
    const jx = roadCoord(j.col);
    const jy = roadCoord(j.row);
    return Math.abs(car.x - jx) < 14 && Math.abs(car.y - jy) < 14;
  }

  // Car directly ahead in the same lane, within lookAhead units.
  function carAhead(car, lookAhead) {
    let best = null;
    let bestD = lookAhead;
    for (const other of cars) {
      if (other === car || other.parked) continue;
      if (other.dir !== car.dir) continue;
      const dx = other.x - car.x;
      const dy = other.y - car.y;
      let along = 0;
      let lateral = 0;
      if (car.dir === 0) { along = dx; lateral = Math.abs(dy); }
      if (car.dir === 2) { along = -dx; lateral = Math.abs(dy); }
      if (car.dir === 1) { along = dy; lateral = Math.abs(dx); }
      if (car.dir === 3) { along = -dy; lateral = Math.abs(dx); }
      if (along > 0 && along < bestD && lateral < 26) { best = other; bestD = along; }
    }
    return best;
  }

  function updateCar(car, dt) {
    // Slow before a junction if a turn is coming: approach speed cap.
    const j = nearestJunction(car.x, car.y);
    const jx = roadCoord(j.col);
    const jy = roadCoord(j.row);
    const distJ = Math.hypot(jx - car.x, jy - car.y);
    let target = car.cruise;
    if (distJ < 130) target = Math.min(target, 170);

    // Slow behind the car ahead (spec §1: traffic slows behind the car ahead).
    const ahead = carAhead(car, 130);
    if (ahead) {
      const gap = Math.hypot(ahead.x - car.x, ahead.y - car.y);
      if (gap < 90) target = Math.min(target, Math.max(0, ahead.speed * 0.85));
      if (gap < 46) target = 0;
    }

    // Accelerate / brake toward target speed.
    if (car.speed < target) car.speed = Math.min(target, car.speed + car.type.accel * dt);
    else if (car.speed > target) car.speed = Math.max(target, car.speed - car.type.accel * 1.6 * dt);

    // Move along the current heading.
    const nx = car.x + Math.cos(car.angle) * car.speed * dt;
    const ny = car.y + Math.sin(car.angle) * car.speed * dt;

    // Stay on roads: if the next step leaves the road band and we are
    // not at a junction, clamp back onto the centreline (slide, no stick).
    const onRoadX = distToRoad(ny) <= ROAD_WIDTH / 2 + 2;
    const onRoadY = distToRoad(nx) <= ROAD_WIDTH / 2 + 2;
    if (onRoadX || onRoadY) {
      car.x = nx;
      car.y = ny;
    } else {
      // Off the road band: steer back toward the nearest road centreline.
      car.speed *= 0.9;
    }

    // Junction decision: pick a new heading (never reverse).
    if (atJunction(car) && car.turnCooldown <= 0 && car.speed > 5) {
      const options = [0, 1, 2, 3].filter((d) => d !== (car.dir + 2) % 4);
      const next = options[Math.floor(rng() * options.length)];
      car.dir = next;
      car.angle = next * Math.PI / 2;
      car.turnCooldown = 0.6;
    }
    car.turnCooldown = Math.max(0, car.turnCooldown - dt);

    // Stuck detection: crawling with no progress for a while -> nudge.
    if (car.speed < 8) car.stuck += dt;
    else car.stuck = 0;
    if (car.stuck > 4) {
      car.speed = 60;
      car.stuck = 0;
    }
  }

  function farFromPlayer(c) {
    const p = game.player;
    if (!p) return true;
    return Math.hypot(c.x - p.x, c.y - p.y) > 700;
  }

  return {
    targetCount,

    update(dt) {
      // Spawn / despawn toward the density target.
      const want = targetCount();
      if (cars.length < want && rng() < 0.5) spawnTrafficCar();
      if (parked.length < 10 && rng() < 0.12) spawnParkedCar();
      // Despawn cars far from the player so the city recycles.
      if (cars.length > want + 4) {
        cars = cars.filter((c) => !farFromPlayer(c) || cars.length <= want);
      }
      for (const car of cars) updateCar(car, dt);
      // Parked cars never move; keep the list fresh.
      if (parked.length > 14) parked.splice(0, parked.length - 14);
    },

    draw(ctx, cam) {
      if (!ctx) return;
      const drawOne = (car) => {
        if (cam) {
          if (car.x < cam.x - 80 || car.x > cam.x + cam.w + 80 ||
              car.y < cam.y - 80 || car.y > cam.y + cam.h + 80) return;
        }
        ctx.save();
        ctx.translate(car.x, car.y);
        // Soft shadow to the south-east (sun from the north-west).
        ctx.fillStyle = 'rgba(20, 16, 60, 0.35)';
        ctx.fillRect(-car.w / 2 + 4, -car.h / 2 + 5, car.w, car.h);
        ctx.rotate(car.angle);
        ctx.fillStyle = car.color;
        ctx.fillRect(-car.w / 2, -car.h / 2, car.w, car.h);
        // Windshield + roof.
        ctx.fillStyle = 'rgba(180, 220, 255, 0.85)';
        ctx.fillRect(car.w * 0.08, -car.h / 2 + 2, car.w * 0.2, car.h - 4);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(-car.w * 0.32, -car.h / 2 + 2, car.w * 0.28, car.h - 4);
        if (car.kind === 'taxi') {
          ctx.fillStyle = '#f1c40f';
          ctx.fillRect(-car.w * 0.05, -car.h / 2, car.w * 0.1, 3);
        }
        ctx.restore();
      };
      for (const car of parked) drawOne(car);
      for (const car of cars) drawOne(car);
    },

    cars() { return cars; },
    parkedCars() { return parked; },

    nearestParked(x, y, maxDist) {
      let best = null;
      let bestD = maxDist || 400;
      for (const car of parked) {
        const d = Math.hypot(car.x - x, car.y - y);
        if (d < bestD) { best = car; bestD = d; }
      }
      return best;
    },

    nearestDriven(x, y, maxDist) {
      let best = null;
      let bestD = maxDist || 400;
      for (const car of cars) {
        const d = Math.hypot(car.x - x, car.y - y);
        if (d < bestD) { best = car; bestD = d; }
      }
      return best;
    },

    // Carjack: the driver flees on foot, the car becomes the player's.
    // Returns the car (now driverless). Stealing a driven car adds heat;
    // the caller (player / police module) owns that rule.
    carjack(car) {
      if (!car) return null;
      const idx = cars.indexOf(car);
      if (idx >= 0) cars.splice(idx, 1);
      const pIdx = parked.indexOf(car);
      if (pIdx >= 0) parked.splice(pIdx, 1);
      if (car.driver && typeof game.onDriverFlee === 'function') {
        game.onDriverFlee(car.x, car.y, car.color);
      }
      car.driver = false;
      car.parked = false;
      car.speed = 0;
      return car;
    },

    // Hand a car back to traffic (e.g. player abandons it far away).
    release(car) {
      if (!car) return;
      car.parked = true;
      car.driver = false;
      car.speed = 0;
      parked.push(car);
    },

    remove(car) {
      cars = cars.filter((c) => c !== car);
      parked = parked.filter((c) => c !== car);
    },

    clear() { cars = []; parked = []; },

    countByType() {
      const out = {};
      for (const car of cars) out[car.kind] = (out[car.kind] || 0) + 1;
      return out;
    },
  };
}

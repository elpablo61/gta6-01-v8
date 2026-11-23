// Living city — depth. Crescent Bay. Fresh from prose spec §3.6 (stretch).
// This is the stretch system: it only runs after §3.1–§3.5 are done and
// tested, and it never blocks the core or the playtest. Three kinds of
// depth, all cosmetic and all defensive (every hook is a no-op when the
// game object it decorates is absent):
//   1. Pedestrian variety — different colours and walking speeds; some
//      pedestrians walk in pairs (a partner keeps a fixed offset).
//   2. Parked-car colour variety — a wider palette than the traffic pool.
//   3. Traffic density varies by time of day — busier at midday, quieter
//      at night; the module reports a target count and, when the game
//      exposes a spawn hook, nudges the live count toward it.
// Nothing here changes missions, wanted level, combat, or saves. The
// helpers are pure and exported so tests can check them without a game.

export const PEDESTRIAN_PALETTE = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#ecf0f1', '#34495e', '#fd79a8',
  '#00cec9', '#fdcb6e', '#6c5ce7', '#d63031', '#55efc4',
];

export const PEDESTRIAN_WALK_SPEEDS = [42, 55, 68, 80, 95];

export const PARKED_CAR_COLORS = [
  '#c0392b', '#2471a3', '#f1c40f', '#27ae60', '#8e44ad',
  '#e67e22', '#16a085', '#ecf0f1', '#2c3e50', '#d35400',
  '#7f8c8d', '#c9a227', '#a93226', '#1f618d', '#b7950b',
];

export const TRAFFIC_DENSITY_BY_HOUR = [
  0.45, 0.4, 0.35, 0.35, 0.4, 0.5, 0.6, 0.75,
  0.85, 0.9, 0.95, 1.0, 1.0, 0.95, 0.9, 0.9,
  0.85, 0.8, 0.7, 0.6, 0.55, 0.5, 0.5, 0.45,
];

export const PAIR_CHANCE = 0.25;
export const PAIR_OFFSET = 26;

export function trafficDensityForHour(hour) {
  const h = Math.floor(Number(hour) || 0);
  const idx = ((h % 24) + 24) % 24;
  return TRAFFIC_DENSITY_BY_HOUR[idx];
}

export function targetTrafficCount(baseCount, hour) {
  const base = Math.max(0, Math.floor(baseCount || 0));
  return Math.max(2, Math.round(base * trafficDensityForHour(hour)));
}

export function pickPedestrianVariant(rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  const color = PEDESTRIAN_PALETTE[Math.floor(roll() * PEDESTRIAN_PALETTE.length)];
  const speed = PEDESTRIAN_WALK_SPEEDS[Math.floor(roll() * PEDESTRIAN_WALK_SPEEDS.length)];
  const paired = roll() < PAIR_CHANCE;
  return { color, walkSpeed: speed, paired, pairOffset: paired ? PAIR_OFFSET : 0 };
}

export function pickParkedCarColor(rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  return PARKED_CAR_COLORS[Math.floor(roll() * PARKED_CAR_COLORS.length)];
}

export function createLivingCity(game) {
  const state = {
    pairsFormed: 0,
    recoloredCars: 0,
    lastDensity: null,
    lastTargetCount: null,
    decorationsApplied: 0,
  };

  function rng() {
    if (game && typeof game.rng === 'function') return game.rng();
    return Math.random;
  }

  function currentHour() {
    if (game && game.time && typeof game.time.hour === 'number') return game.time.hour;
    if (game && typeof game.hour === 'number') return game.hour;
    return 12;
  }

  // Give one pedestrian a colour + walking speed. If it is paired, the
  // partner id is recorded on the pedestrian for the walker to follow.
  function decoratePedestrian(ped) {
    if (!ped || typeof ped !== 'object') return null;
    const variant = pickPedestrianVariant(rng());
    ped.color = variant.color;
    ped.walkSpeed = variant.walkSpeed;
    ped.paired = variant.paired;
    ped.pairOffset = variant.pairOffset;
    ped.variant = variant;
    state.decorationsApplied += 1;
    return ped;
  }

  // Pair up pedestrians that are already walking near each other: the
  // second one follows the first at a fixed side offset.
  function pairWalkers(pedestrians) {
    if (!Array.isArray(pedestrians)) return 0;
    let formed = 0;
    const free = pedestrians.filter((p) => p && !p.pairedWith && !p.paired);
    for (let i = 0; i + 1 < free.length; i += 2) {
      const a = free[i];
      const b = free[i + 1];
      const dx = (a.x || 0) - (b.x || 0);
      const dy = (a.y || 0) - (b.y || 0);
      if (dx * dx + dy * dy > 120 * 120) continue;
      a.pairedWith = b;
      b.pairedWith = a;
      b.followOffset = PAIR_OFFSET;
      a.paired = true;
      b.paired = true;
      formed += 1;
    }
    state.pairsFormed += formed;
    return formed;
  }

  function decorateParkedCar(car) {
    if (!car || typeof car !== 'object') return null;
    car.color = pickParkedCarColor(rng());
    car.parkedVariant = true;
    state.recoloredCars += 1;
    return car;
  }

  function decorateParkedCars(cars) {
    if (!Array.isArray(cars)) return 0;
    let n = 0;
    for (const car of cars) {
      if (car && car.parked && !car.parkedVariant) {
        decorateParkedCar(car);
        n += 1;
      }
    }
    return n;
  }

  function densityNow() {
    return trafficDensityForHour(currentHour());
  }

  // Nudge the live traffic count toward the time-of-day target. The game
  // exposes spawnTraffic(n) / despawnTraffic(n) when it wants nudging;
  // without those hooks this only reports the target and returns it.
  function applyTrafficDensity(baseCount) {
    const density = densityNow();
    const target = targetTrafficCount(baseCount, currentHour());
    state.lastDensity = density;
    state.lastTargetCount = target;
    if (game && Array.isArray(game.traffic)) {
      const live = game.traffic.length;
      if (live < target && typeof game.spawnTraffic === 'function') {
        try { game.spawnTraffic(target - live); } catch (e) { /* optional */ }
      } else if (live > target && typeof game.despawnTraffic === 'function') {
        try { game.despawnTraffic(live - target); } catch (e) { /* optional */ }
      }
    }
    return target;
  }

  function update(dt) {
    if (game && Array.isArray(game.pedestrians)) {
      for (const ped of game.pedestrians) {
        if (ped && !ped.variant) decoratePedestrian(ped);
      }
    }
    if (game && Array.isArray(game.vehicles)) {
      decorateParkedCars(game.vehicles);
    }
    if (typeof dt === 'number') {
      state._densityTimer = (state._densityTimer || 0) + dt;
      if (state._densityTimer > 5) {
        state._densityTimer = 0;
        const base = game && typeof game.baseTrafficCount === 'number'
          ? game.baseTrafficCount
          : 20;
        applyTrafficDensity(base);
      }
    }
    return state;
  }

  function snapshot() {
    return {
      hour: currentHour(),
      density: densityNow(),
      lastTargetCount: state.lastTargetCount,
      pairsFormed: state.pairsFormed,
      recoloredCars: state.recoloredCars,
      decorationsApplied: state.decorationsApplied,
    };
  }

  return {
    state,
    update,
    decoratePedestrian,
    pairWalkers,
    decorateParkedCar,
    decorateParkedCars,
    applyTrafficDensity,
    densityNow,
    trafficDensityForHour,
    targetTrafficCount,
    snapshot,
  };
}

export default createLivingCity;

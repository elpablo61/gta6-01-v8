// world.js — the city of Crescent Bay: its roads, districts, buildings,
// beach, landmarks, and the road-graph router every driver in the game
// uses (traffic, police, the autopilot, mission couriers).
//
// Layout (from the prose spec, section 1):
//   * The world is 3200 x 3200 units.
//   * An 8 x 8 road grid: roads run at 200 + i * 400 for i = 0..7, both
//     directions, each 64 units wide. The crossings are the junctions.
//   * Districts: Northside (houses) in the north, Old Town (brick) in the
//     west-centre, Downtown (glass towers) in the centre-east, Waterfront
//     (sand) along the east, South Docks (industrial) in the south.
//   * Beach and open water at the east edge (x > 3060), with a marina and
//     a pier reaching into the water.
//   * Buildings are drawn 2.5D: a roof plus darker south and east sides,
//     with blue-purple shadows falling to the south-east (the sun stands
//     in the north-west).
//   * A day/night cycle drives the light, the headlights and the traffic
//     density.
//
// Routing: junctions are indexed row-major, id = row * 8 + col, and the
// BFS parent chain is walked with that same indexing everywhere. (An
// earlier build transposed the index and looped forever; the index is
// built once, in one place, and never recomputed ad hoc.)

import { SeededRandom, WORLD_SEED, hashCoords } from './random.js';

export const WORLD_SIZE = 3200;
export const ROAD_COUNT = 8;
export const ROAD_SPACING = 400;
export const ROAD_OFFSET = 200;
export const ROAD_WIDTH = 64;
export const ROAD_HALF = ROAD_WIDTH / 2;
export const BEACH_START = 3032;
export const WATER_START = 3060;

// Road centre lines, in world units.
export const ROAD_LINES = [];
for (let i = 0; i < ROAD_COUNT; i++) ROAD_LINES.push(ROAD_OFFSET + i * ROAD_SPACING);

export const DISTRICTS = {
  northside: { name: 'Northside', kind: 'houses' },
  oldtown: { name: 'Old Town', kind: 'brick' },
  downtown: { name: 'Downtown', kind: 'towers' },
  waterfront: { name: 'Waterfront', kind: 'sand' },
  docks: { name: 'South Docks', kind: 'industrial' },
};

// Which district a point belongs to. Waterfront hugs the east edge,
// the docks hold the south, Downtown sits centre-east, Old Town
// west-centre, and everything north is Northside houses.
export function districtAt(x, y) {
  if (x >= 2600) return 'waterfront';
  if (y >= 2600) return 'docks';
  if (x >= 1800 && y >= 1400 && y < 2600) return 'downtown';
  if (x < 1400 && y >= 1000 && y < 2600) return 'oldtown';
  return 'northside';
}

export function isWater(x, y) {
  return x > WATER_START;
}

export function isBeach(x, y) {
  return x > BEACH_START && x <= WATER_START;
}

export function isOnRoad(x, y) {
  for (const line of ROAD_LINES) {
    if (Math.abs(x - line) <= ROAD_HALF || Math.abs(y - line) <= ROAD_HALF) return true;
  }
  return false;
}

// Clamp a point into the world, keeping a margin from the edge.
export function clampToWorld(x, y, margin) {
  const m = margin === undefined ? 40 : margin;
  return {
    x: Math.max(m, Math.min(WORLD_SIZE - m, x)),
    y: Math.max(m, Math.min(WORLD_SIZE - m, y)),
  };
}

// The junction at (col, row): the crossing of road col and road row.
export function junctionAt(col, row) {
  return { x: ROAD_LINES[col], y: ROAD_LINES[row], col, row, id: row * ROAD_COUNT + col };
}

export function junctionById(id) {
  const row = Math.floor(id / ROAD_COUNT);
  const col = id % ROAD_COUNT;
  return junctionAt(col, row);
}

// Nearest junction to a point (by grid, not by search).
export function nearestJunction(x, y) {
  const col = Math.max(0, Math.min(ROAD_COUNT - 1, Math.round((x - ROAD_OFFSET) / ROAD_SPACING)));
  const row = Math.max(0, Math.min(ROAD_COUNT - 1, Math.round((y - ROAD_OFFSET) / ROAD_SPACING)));
  return junctionAt(col, row);
}

// Nearest point on any road to (x, y): snap to the closest road line.
export function nearestRoadPoint(x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const line of ROAD_LINES) {
    const dVertical = Math.abs(x - line);
    if (dVertical < bestDist) {
      bestDist = dVertical;
      best = { x: line, y: Math.max(0, Math.min(WORLD_SIZE, y)) };
    }
    const dHorizontal = Math.abs(y - line);
    if (dHorizontal < bestDist) {
      bestDist = dHorizontal;
      best = { x: Math.max(0, Math.min(WORLD_SIZE, x)), y: line };
    }
  }
  return best;
}

// Breadth-first route over the junction graph. Returns an array of
// waypoints [{x, y}, ...] from the junction nearest `from` to the junction
// nearest `to`, INCLUDING the first junction as the first waypoint: a
// driver must never cut diagonally across a block. Neighbours are the
// four orthogonal junctions; the graph is a plain grid so BFS is exact.
export function findRoute(fromX, fromY, toX, toY) {
  const start = nearestJunction(fromX, fromY);
  const goal = nearestJunction(toX, toY);
  if (start.id === goal.id) return [{ x: goal.x, y: goal.y }];

  const parent = new Int32Array(ROAD_COUNT * ROAD_COUNT).fill(-1);
  const queue = [start.id];
  parent[start.id] = start.id;
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current === goal.id) break;
    const row = Math.floor(current / ROAD_COUNT);
    const col = current % ROAD_COUNT;
    const neighbours = [];
    if (col > 0) neighbours.push(current - 1);
    if (col < ROAD_COUNT - 1) neighbours.push(current + 1);
    if (row > 0) neighbours.push(current - ROAD_COUNT);
    if (row < ROAD_COUNT - 1) neighbours.push(current + ROAD_COUNT);
    for (const next of neighbours) {
      if (parent[next] === -1) {
        parent[next] = current;
        queue.push(next);
      }
    }
  }
  if (parent[goal.id] === -1) return [{ x: goal.x, y: goal.y }];

  const path = [];
  let node = goal.id;
  while (node !== start.id) {
    path.push(junctionById(node));
    node = parent[node];
  }
  path.push(start);
  path.reverse();
  return path.map((j) => ({ x: j.x, y: j.y }));
}

// Distance along a route (sum of legs), for ETAs and chase logic.
export function routeLength(waypoints) {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += Math.hypot(waypoints[i].x - waypoints[i - 1].x, waypoints[i].y - waypoints[i - 1].y);
  }
  return total;
}

// Building palettes per district kind.
const BUILDING_STYLE = {
  houses: { colors: ['#e8c9a0', '#d9b48a', '#cfa07a', '#e0d3b8'], heights: [26, 34, 42] },
  brick: { colors: ['#a85f46', '#96604a', '#b06a4e', '#8f5340'], heights: [40, 56, 72] },
  towers: { colors: ['#7fa8c9', '#6d9ab8', '#8fb4cc', '#5f8aa8'], heights: [90, 130, 170, 210] },
  sand: { colors: ['#e6d9b8', '#dccfa8', '#efe3c2'], heights: [30, 44, 58] },
  industrial: { colors: ['#8a8f96', '#7a7f88', '#9aa0a8', '#6f747c'], heights: [36, 52, 68] },
};

// Fixed places the missions and systems need. Each sits on a road so a
// driver can always reach it; the marker is the point the objective
// banner points at.
export const LANDMARKS = {
  market: { name: 'Market', x: 600, y: 600 },
  downtown: { name: 'Downtown Drop', x: 2200, y: 1800 },
  club: { name: 'Club Mirage', x: 1800, y: 2200 },
  marina: { name: 'Marina', x: 3000, y: 1000 },
  airport: { name: 'Crescent Airport', x: 600, y: 2600 },
  hideout: { name: 'Hideout', x: 1000, y: 1400 },
  docks: { name: 'South Docks', x: 1400, y: 3000 },
  bank: { name: 'Bay Bank', x: 2200, y: 1400 },
  gunStore: { name: 'Gun Store', x: 1000, y: 2200 },
  fixerGarage: { name: 'Fixer Garage', x: 1400, y: 1800 },
  sprayShop: { name: 'Spray Shop', x: 2600, y: 2200 },
  pier: { name: 'Pier', x: 3120, y: 1400 },
};

// Build the whole static city from the seeded stream. Returns the
// buildings (with 2.5D heights and palettes), the pier, the lamp posts
// along the roads, and the parked-car bays the traffic system fills.
export function createWorld(seed) {
  const rng = new SeededRandom(seed === undefined ? WORLD_SEED : seed);
  const buildings = [];
  const lamps = [];
  const parkedBays = [];

  for (let bx = 0; bx < ROAD_COUNT - 1; bx++) {
    for (let by = 0; by < ROAD_COUNT - 1; by++) {
      const blockX0 = ROAD_LINES[bx] + ROAD_HALF + 16;
      const blockY0 = ROAD_LINES[by] + ROAD_HALF + 16;
      const blockX1 = ROAD_LINES[bx + 1] - ROAD_HALF - 16;
      const blockY1 = ROAD_LINES[by + 1] - ROAD_HALF - 16;
      const centreX = (blockX0 + blockX1) / 2;
      const centreY = (blockY0 + blockY1) / 2;
      const district = districtAt(centreX, centreY);
      const style = BUILDING_STYLE[DISTRICTS[district].kind];

      // The waterfront's eastern blocks are sand, not buildings.
      if (district === 'waterfront' && bx >= 6) continue;

      const count = district === 'downtown' ? rng.int(1, 2) : rng.int(1, 3);
      for (let i = 0; i < count; i++) {
        const w = rng.range(90, 190);
        const h = rng.range(90, 190);
        const x = rng.range(blockX0, Math.max(blockX0 + 1, blockX1 - w));
        const y = rng.range(blockY0, Math.max(blockY0 + 1, blockY1 - h));
        const height = rng.pick(style.heights) * rng.range(0.85, 1.15);
        const color = rng.pick(style.colors);
        buildings.push({
          x, y, w, h, height,
          color,
          district,
          // Deterministic per-block shade so the same block always looks
          // the same.
          shade: hashCoords(bx * 7 + i, by * 7 + i),
        });
      }

      // A parked-car bay on one side of most blocks.
      if (rng.chance(0.7)) {
        parkedBays.push({
          x: blockX0 + rng.range(0, 60),
          y: blockY1 - 8,
          angle: 0,
          district,
        });
      }
    }
  }

  // Street lamps at every other junction corner.
  for (let col = 0; col < ROAD_COUNT; col++) {
    for (let row = 0; row < ROAD_COUNT; row++) {
      if ((col + row) % 2 === 0) {
        lamps.push({ x: ROAD_LINES[col] + ROAD_HALF + 10, y: ROAD_LINES[row] + ROAD_HALF + 10 });
      }
    }
  }

  // The pier reaches east from the marina road into the water.
  const pier = {
    x0: ROAD_LINES[7], y0: LANDMARKS.marina.y - 24,
    x1: 3180, y1: LANDMARKS.marina.y + 24,
  };

  return { buildings, lamps, parkedBays, pier, seed: rng.seed };
}

// --- Day / night ---------------------------------------------------------
// The clock runs 0..24. 06:00-18:00 is day, 18:00-20:00 dusk, 20:00-06:00
// night, 06:00-08:00 dawn. `daylight` is 1 at noon, 0 at midnight.

export const DAY_LENGTH_SECONDS = 480; // one full day per 8 minutes

export function daylightAt(hour) {
  if (hour >= 6 && hour <= 18) {
    const t = (hour - 6) / 12;
    return Math.sin(t * Math.PI) * 0.85 + 0.15;
  }
  if (hour > 18 && hour < 20) return 0.15 * (1 - (hour - 18) / 2);
  if (hour >= 4 && hour < 6) return 0.15 * ((hour - 4) / 2);
  return 0;
}

export function isNight(hour) {
  return daylightAt(hour) < 0.25;
}

export function timeLabel(hour) {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return hh + ':' + mm;
}

// Traffic density factor by time of day: busier at midday, quieter at
// night (spec section 3.6).
export function trafficDensityAt(hour) {
  if (hour >= 7 && hour <= 9) return 1.0;
  if (hour >= 11 && hour <= 14) return 1.0;
  if (hour >= 17 && hour <= 19) return 0.9;
  if (hour >= 22 || hour < 5) return 0.35;
  return 0.65;
}

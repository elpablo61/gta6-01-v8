// Crescent Bay — the city: roads, districts, buildings, beach, marina.
// The world is a fixed 3200x3200 map built once from a seeded generator,
// so every fresh game has the same streets, the same blocks and the same
// landmarks. Nothing here moves; traffic, pedestrians and the player all
// navigate on the road graph this module builds.
//
// Road graph (the one rule everything else depends on):
//   * 8 roads run north-south and 8 run east-west, at 200 + i * 400
//     (200, 600, 1000, 1400, 1800, 2200, 2600, 3000), each 64 wide.
//   * A junction is where a north-south road meets an east-west road.
//   * Junction ids are row-major and CONSISTENT: id = row * 8 + col,
//     where col comes from x and row comes from y. Never swap them —
//     a transposed index once made the parent-chain walk cycle forever
//     and froze the whole page.
//   * Routes are found by BFS over junction ids and ALWAYS include the
//     first junction as the first waypoint, so a car drives along its
//     own road to the intersection instead of cutting diagonally
//     across a block.

import { Rng, WORLD_SEED } from './random.js';

export const WORLD_SIZE = 3200;
export const WORLD_WIDTH = 3200;
export const WORLD_HEIGHT = 3200;
export const ROAD_COUNT = 8;
export const ROAD_SPACING = 400;
export const ROAD_OFFSET = 200;
export const ROAD_WIDTH = 64;
export const ROAD_HALF = ROAD_WIDTH / 2;
export const SIDEWALK = 16;
export const WATER_EDGE_X = 3060;
export const BEACH_EDGE_X = 2960;

// Player spawn: clear of the mission-garage trigger radius, so no dialog
// opens the moment the game starts and swallows the first key press.
export const PLAYER_SPAWN = { x: 600, y: 800 };

// Centre line of road number i (0..7).
export function roadCoord(i) {
  return ROAD_OFFSET + i * ROAD_SPACING;
}

export const ROAD_LINES = [0, 1, 2, 3, 4, 5, 6, 7].map(roadCoord);

// Clamp an index into the 0..7 road range.
export function clampRoadIndex(i) {
  return Math.max(0, Math.min(ROAD_COUNT - 1, i));
}

// Junction id from column (x) and row (y). Row-major, always.
export function junctionId(col, row) {
  return clampRoadIndex(row) * ROAD_COUNT + clampRoadIndex(col);
}

// Column / row of a junction id.
export function junctionCol(id) {
  return id % ROAD_COUNT;
}

export function junctionRow(id) {
  return Math.floor(id / ROAD_COUNT);
}

// World position of a junction id.
export function junctionPos(id) {
  return { x: roadCoord(junctionCol(id)), y: roadCoord(junctionRow(id)) };
}

// Nearest junction id to a world point. The column is derived from x,
// the row from y — this is the consistency the route finder relies on.
export function nearestJunctionId(x, y) {
  const col = clampRoadIndex(Math.round((x - ROAD_OFFSET) / ROAD_SPACING));
  const row = clampRoadIndex(Math.round((y - ROAD_OFFSET) / ROAD_SPACING));
  return junctionId(col, row);
}

export function nearestJunction(x, y) {
  return junctionPos(nearestJunctionId(x, y));
}

// Neighbour junction ids (up/down/left/right, staying inside the grid).
export function junctionNeighbours(id) {
  const col = junctionCol(id);
  const row = junctionRow(id);
  const out = [];
  if (col > 0) out.push(junctionId(col - 1, row));
  if (col < ROAD_COUNT - 1) out.push(junctionId(col + 1, row));
  if (row > 0) out.push(junctionId(col, row - 1));
  if (row < ROAD_COUNT - 1) out.push(junctionId(col, row + 1));
  return out;
}

// BFS over junction ids. Returns the list of junction ids from start to
// goal inclusive, or null if no path exists (it always exists on a full
// grid, but callers must handle null anyway). The parent chain is walked
// with a visited set and a hard step cap, so it can never cycle forever.
export function findJunctionPath(fromId, toId) {
  if (fromId === toId) return [fromId];
  const parent = new Int16Array(ROAD_COUNT * ROAD_COUNT).fill(-1);
  const seen = new Uint8Array(ROAD_COUNT * ROAD_COUNT);
  const queue = [fromId];
  seen[fromId] = 1;
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    for (const next of junctionNeighbours(cur)) {
      if (seen[next]) continue;
      seen[next] = 1;
      parent[next] = cur;
      if (next === toId) {
        // Walk the parent chain back to the start. Guarded: at most one
        // step per junction, and a visited check breaks any bad chain.
        const path = [toId];
        const walked = new Set([toId]);
        let node = toId;
        let guard = 0;
        while (node !== fromId && guard < ROAD_COUNT * ROAD_COUNT + 2) {
          node = parent[node];
          if (node < 0 || walked.has(node)) return null;
          walked.add(node);
          path.push(node);
          guard += 1;
        }
        if (node !== fromId) return null;
        path.reverse();
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

// Route between two world points as a list of {x, y} waypoints.
// The FIRST waypoint is always the junction nearest the start, so the
// driver travels along its own road first and never cuts a block corner.
// The last waypoint is the junction nearest the target; callers driving
// to a fixed landmark add the final straight leg themselves.
export function findRoute(fromX, fromY, toX, toY) {
  const fromJ = nearestJunctionId(fromX, fromY);
  const toJ = nearestJunctionId(toX, toY);
  const ids = findJunctionPath(fromJ, toJ);
  if (!ids) return [junctionPos(fromJ)];
  return ids.map(junctionPos);
}

export const findRoutePoints = findRoute;
export const routeBetween = findRoute;

// Nearest point on any road centre line to (x, y).
export function nearestRoadPoint(x, y) {
  let bestX = ROAD_LINES[0];
  let bestDx = Math.abs(x - bestX);
  for (const line of ROAD_LINES) {
    const d = Math.abs(x - line);
    if (d < bestDx) {
      bestDx = d;
      bestX = line;
    }
  }
  let bestY = ROAD_LINES[0];
  let bestDy = Math.abs(y - bestY);
  for (const line of ROAD_LINES) {
    const d = Math.abs(y - line);
    if (d < bestDy) {
      bestDy = d;
      bestY = line;
    }
  }
  // The closer of the nearest vertical road and the nearest horizontal one.
  if (bestDx <= bestDy) return { x: bestX, y };
  return { x, y: bestY };
}

// True when (x, y) lies within tol of a road centre line.
export function pointOnRoad(x, y, tol = 42) {
  for (const line of ROAD_LINES) {
    if (Math.abs(x - line) <= tol || Math.abs(y - line) <= tol) return true;
  }
  return false;
}

// Distance from (x, y) to the nearest road centre line.
export function distanceToRoad(x, y) {
  let best = Infinity;
  for (const line of ROAD_LINES) {
    best = Math.min(best, Math.abs(x - line), Math.abs(y - line));
  }
  return best;
}

// District of a world point. North is houses, the west-centre is brick
// Old Town, the middle is glass Downtown, the east is sandy Waterfront,
// the south is industrial South Docks; the far east strip is beach.
export function districtAt(x, y) {
  if (x >= BEACH_EDGE_X) return 'beach';
  if (y < 1100) return 'northside';
  if (y >= 2100) return 'southdocks';
  if (x >= 2500) return 'waterfront';
  if (x >= 1300 && x < 2400) return 'downtown';
  return 'oldtown';
}

export const DISTRICT_NAMES = {
  northside: 'Northside',
  oldtown: 'Old Town',
  downtown: 'Downtown',
  waterfront: 'Waterfront',
  southdocks: 'South Docks',
  beach: 'Beach',
};

// Roof/base colours per district, warm coastal palette. The renderer
// darkens the south and east sides from these and drops a blue-purple
// shadow to the south-east (sun from the north-west).
const DISTRICT_STYLES = {
  northside: { colors: ['#c98f5f', '#b97a4e', '#d9a06b', '#a9714b'], height: [10, 18], kinds: ['house'] },
  oldtown: { colors: ['#9c5a44', '#8a4a38', '#a96850', '#7d4030'], height: [16, 30], kinds: ['brick'] },
  downtown: { colors: ['#7fa8c9', '#6b98bd', '#8fb4d4', '#5f8cad'], height: [34, 58], kinds: ['tower'] },
  waterfront: { colors: ['#d9c08a', '#cbb27a', '#e0c996', '#bfa468'], height: [10, 22], kinds: ['house'] },
  southdocks: { colors: ['#8a8f96', '#767b82', '#9aa0a8', '#6b7076'], height: [14, 26], kinds: ['shed'] },
};

// Named places the missions and the autopilot drive to. Every landmark
// sits beside a road (never deep inside a block) so a car can reach it
// by road plus one short straight final leg.
export const LANDMARKS = {
  market: { x: 600, y: 600, label: 'Market' },
  downtown: { x: 1800, y: 1400, label: 'Downtown' },
  club: { x: 2200, y: 600, label: 'Club' },
  marina: { x: 2960, y: 2200, label: 'Marina' },
  airport: { x: 600, y: 2900, label: 'Airport' },
  hideout: { x: 1000, y: 2600, label: 'Hideout' },
  fixerGarage: { x: 1400, y: 1800, label: 'Fixer Garage' },
  sprayShop: { x: 1800, y: 2600, label: 'Spray Shop' },
  gunStore: { x: 1000, y: 1000, label: 'Gun Store' },
  docks: { x: 2600, y: 2600, label: 'Docks' },
  bank: { x: 1800, y: 1800, label: 'Bank' },
  plane: { x: 600, y: 3000, label: 'Plane' },
  beach: { x: 3050, y: 1000, label: 'Beach' },
  pier: { x: 3080, y: 1800, label: 'Pier' },
};

// Build the whole city from a seed. Buildings live inside blocks (never
// on a road, never in the water); a few blocks are parks instead.
export function createWorld(seed = WORLD_SEED) {
  const rng = new Rng(seed);
  const buildings = [];
  const parks = [];
  const trees = [];

  for (let bx = 0; bx < ROAD_COUNT - 1; bx += 1) {
    for (let by = 0; by < ROAD_COUNT - 1; by += 1) {
      const x0 = roadCoord(bx) + ROAD_HALF + SIDEWALK + 8;
      const y0 = roadCoord(by) + ROAD_HALF + SIDEWALK + 8;
      const x1 = roadCoord(bx + 1) - ROAD_HALF - SIDEWALK - 8;
      const y1 = roadCoord(by + 1) - ROAD_HALF - SIDEWALK - 8;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      // The far-east column is beach/water: no buildings there.
      if (x0 >= BEACH_EDGE_X - 40) continue;
      const district = districtAt(cx, cy);
      // Roughly one block in nine is a park (never downtown's core).
      if (district !== 'downtown' && rng.chance(0.11)) {
        parks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, district });
        for (let t = 0; t < 5; t += 1) {
          trees.push({ x: rng.range(x0 + 20, x1 - 20), y: rng.range(y0 + 20, y1 - 20), r: rng.range(10, 18) });
        }
        continue;
      }
      const style = DISTRICT_STYLES[district] || DISTRICT_STYLES.oldtown;
      const count = district === 'downtown' ? rng.int(1, 2) : rng.int(1, 3);
      for (let b = 0; b < count; b += 1) {
        const w = district === 'downtown' ? rng.range(90, 150) : rng.range(70, 150);
        const h = district === 'downtown' ? rng.range(90, 150) : rng.range(70, 140);
        const px = rng.range(x0, Math.max(x0 + 1, x1 - w));
        const py = rng.range(y0, Math.max(y0 + 1, y1 - h));
        // Keep buildings inside one block from overlapping each other.
        let overlaps = false;
        for (const other of buildings) {
          if (px < other.x + other.w + 12 && px + w + 12 > other.x && py < other.y + other.h + 12 && py + h + 12 > other.y) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;
        buildings.push({
          x: px,
          y: py,
          w,
          h,
          height: rng.range(style.height[0], style.height[1]),
          color: rng.pick(style.colors),
          kind: rng.pick(style.kinds),
          district,
        });
      }
      if (district !== 'downtown' && rng.chance(0.4)) {
        trees.push({ x: rng.range(x0 + 16, x1 - 16), y: rng.range(y0 + 16, y1 - 16), r: rng.range(9, 15) });
      }
    }
  }

  // Marina and pier on the east edge: a wooden pier reaching into the
  // water and a few moored boats. The pier itself is walkable ground.
  const pier = { x: 3000, y: 1760, w: 150, h: 80 };
  const boats = [];
  for (let i = 0; i < 5; i += 1) {
    boats.push({ x: rng.range(3100, 3180), y: 1500 + i * 110 + rng.range(-20, 20), angle: rng.range(-0.4, 0.4) });
  }

  // One street lamp per junction, offset to the corner, for the night
  // light pools the renderer draws.
  const lamps = [];
  for (let col = 0; col < ROAD_COUNT; col += 1) {
    for (let row = 0; row < ROAD_COUNT; row += 1) {
      lamps.push({ x: roadCoord(col) + 44, y: roadCoord(row) + 44 });
    }
  }

  const world = {
    size: WORLD_SIZE,
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    seed,
    buildings,
    parks,
    trees,
    lamps,
    pier,
    boats,
    landmarks: LANDMARKS,
    spawn: PLAYER_SPAWN,
  };

  // --- Collision helpers (bound to this world's buildings) ---

  // True when the point is water (east of the water edge, off the pier).
  world.isWater = function isWater(x, y) {
    if (x < WATER_EDGE_X) return false;
    if (x >= pier.x && x <= pier.x + pier.w && y >= pier.y && y <= pier.y + pier.h) return false;
    return true;
  };

  // The building whose footprint contains (x, y), or null.
  world.buildingAt = function buildingAt(x, y) {
    for (const b of buildings) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  };

  // True when (x, y) cannot be stood on: outside the map, in the water,
  // or inside a building. pad grows the blocked area (use the mover's
  // radius so bodies never sink into walls).
  world.isBlocked = function isBlocked(x, y, pad = 0) {
    if (x < 12 + pad || y < 12 + pad || x > WORLD_SIZE - 12 - pad || y > WORLD_SIZE - 12 - pad) return true;
    if (world.isWater(x, y)) return true;
    for (const b of buildings) {
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return true;
    }
    return false;
  };

  // Move with wall sliding: try the full step, then x-only, then y-only.
  // A mover sliding along a wall keeps going instead of sticking to it.
  world.tryMove = function tryMove(x, y, dx, dy, radius = 12) {
    if (!world.isBlocked(x + dx, y + dy, radius)) return { x: x + dx, y: y + dy, hitX: false, hitY: false };
    const xOk = !world.isBlocked(x + dx, y, radius);
    const yOk = !world.isBlocked(x, y + dy, radius);
    return {
      x: xOk ? x + dx : x,
      y: yOk ? y + dy : y,
      hitX: !xOk,
      hitY: !yOk,
    };
  };

  world.districtAt = districtAt;
  world.nearestJunction = nearestJunction;
  world.nearestRoadPoint = nearestRoadPoint;
  world.findRoute = findRoute;
  return world;
}

// The shared world instance: built once at import from the fixed seed.
// Modules that need their own copy (tests, screenshots) call createWorld.
export const world = createWorld(WORLD_SEED);
export default world;

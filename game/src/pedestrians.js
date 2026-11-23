// Pedestrians — people on the sidewalks (Crescent Bay).
//
// Fresh from prose spec §1 + §3.6. Pedestrians walk the sidewalks and
// flee when scared: a gunshot nearby, a speeding car bearing down, or
// Rook pointing a gun at them. They come in many colours and walking
// speeds, and about a quarter of them walk in pairs, side by side.
// Walking follows the road graph: a pedestrian picks a road, walks
// along it on the sidewalk (offset from the centreline), and turns at
// a junction instead of cutting across a block. Nobody walks through
// a building or into the water.
//
// Shared-state contract (everything read defensively):
//   game.player { x, y, speed, onFoot } — Rook; fast cars scare peds.
//   game.cars   — array of car objects; a speeding car nearby scares peds.
//   game.peds / game.pedestrians — the shared pedestrian list (kept in
//                sync with this module's list so the renderer draws them).
//   game.world  { isBlocked(x, y), tryMove(x, y, dx, dy) } — collision.
//   game.lastGunshot { x, y, at } — written by combat on every shot.
//   game.state  — only walk while 'playing' (or when unset, for tests).
// Pedestrian shape (shared with player.js carjacking + render.js):
//   { x, y, angle, speed, walkSpeed, color, paired, pairedWith,
//     state: 'walk' | 'flee', fleeing, fleeT, fleeFromX, fleeFromY }

export const PEDESTRIAN_PALETTE = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#ecf0f1', '#34495e', '#fd79a8',
  '#00cec9', '#fdcb6e', '#6c5ce7', '#d63031', '#55efc4',
];

export const PEDESTRIAN_WALK_SPEEDS = [42, 55, 68, 80, 95];
export const PEDESTRIAN_FLEE_SPEED = 210;
export const PEDESTRIAN_TARGET_COUNT = 28;
export const PEDESTRIAN_PAIR_CHANCE = 0.25;
export const PEDESTRIAN_PAIR_OFFSET = 26;
export const PEDESTRIAN_SCARE_RADIUS = 260;
export const PEDESTRIAN_CAR_SCARE_RADIUS = 120;
export const PEDESTRIAN_CAR_SCARE_SPEED = 200;
export const PEDESTRIAN_SIDEWALK_OFFSET = 46;
export const PEDESTRIAN_SPAWN_MIN = 480;
export const PEDESTRIAN_SPAWN_MAX = 950;
export const PEDESTRIAN_DESPAWN_DISTANCE = 1150;

const ROAD_LINES = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function blockedAt(game, x, y) {
  if (x < 20 || x > 3180 || y < 20 || y > 3180) return true;
  if (game && game.world && typeof game.world.isBlocked === 'function') {
    return game.world.isBlocked(x, y, 8);
  }
  // Fallback from spec geometry: off the road + sidewalk is a block.
  let nearest = Infinity;
  for (const c of ROAD_LINES) nearest = Math.min(nearest, Math.abs(x - c), Math.abs(y - c));
  return nearest > 46;
}

// A walkable sidewalk point: on a road centreline, offset to the side.
function sidewalkPoint() {
  const line = pick(ROAD_LINES);
  const along = 120 + Math.random() * 2960;
  const side = Math.random() < 0.5 ? -1 : 1;
  if (Math.random() < 0.5) return { x: line + side * PEDESTRIAN_SIDEWALK_OFFSET, y: along };
  return { x: along, y: line + side * PEDESTRIAN_SIDEWALK_OFFSET };
}

export function createPedestrian(x, y, opts) {
  const o = opts || {};
  const paired = o.paired !== undefined ? o.paired : Math.random() < PEDESTRIAN_PAIR_CHANCE;
  return {
    x, y,
    angle: o.angle !== undefined ? o.angle : Math.random() * Math.PI * 2,
    speed: 0,
    walkSpeed: o.walkSpeed || pick(PEDESTRIAN_WALK_SPEEDS),
    color: o.color || pick(PEDESTRIAN_PALETTE),
    paired,
    pairOffset: paired ? PEDESTRIAN_PAIR_OFFSET : 0,
    pairedWith: null,
    state: 'walk',
    fleeing: false,
    fleeT: 0,
    fleeFromX: 0,
    fleeFromY: 0,
    dirX: o.dirX !== undefined ? o.dirX : (Math.random() < 0.5 ? -1 : 1),
    dirY: o.dirY !== undefined ? o.dirY : 0,
    turnT: 2 + Math.random() * 6,
  };
}

export function createPedestrians(game) {
  const state = {
    list: [],
    spawned: 0,
    fled: 0,
    pairsFormed: 0,
  };

  function playerPos() {
    const p = game && game.player;
    if (p && typeof p.x === 'number') return p;
    return { x: 1600, y: 1600, speed: 0 };
  }

  function syncList() {
    if (!game) return;
    game.peds = state.list;
    game.pedestrians = state.list;
  }

  function spawnPedestrian(x, y, opts) {
    const ped = createPedestrian(x, y, opts);
    state.list.push(ped);
    state.spawned += 1;
    syncList();
    return ped;
  }

  // Spawn one pedestrian on a sidewalk near the player, at a random
  // road, walking along it. Paired peds spawn with a partner beside them.
  function spawnNearPlayer() {
    const p = playerPos();
    for (let tries = 0; tries < 10; tries++) {
      const pt = sidewalkPoint();
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d < PEDESTRIAN_SPAWN_MIN || d > PEDESTRIAN_SPAWN_MAX) continue;
      if (blockedAt(game, pt.x, pt.y)) continue;
      const ped = spawnPedestrian(pt.x, pt.y);
      // Pair up: a partner walks beside this one, same direction.
      if (ped.paired) {
        const partner = spawnPedestrian(
          pt.x + (ped.dirY === 0 ? 0 : PEDESTRIAN_PAIR_OFFSET),
          pt.y + (ped.dirY === 0 ? PEDESTRIAN_PAIR_OFFSET : 0),
          { color: pick(PEDESTRIAN_PALETTE), walkSpeed: ped.walkSpeed, paired: true, dirX: ped.dirX, dirY: ped.dirY },
        );
        ped.pairedWith = partner;
        partner.pairedWith = ped;
        state.pairsFormed += 1;
      }
      return ped;
    }
    return null;
  }

  // Every pedestrian within radius of (x, y) runs away from it.
  function scarePedestrians(x, y, radius) {
    const r = radius || PEDESTRIAN_SCARE_RADIUS;
    let n = 0;
    for (const ped of state.list) {
      if (!ped || ped.dead) continue;
      if (Math.hypot(ped.x - x, ped.y - y) < r) {
        ped.state = 'flee';
        ped.fleeing = true;
        ped.fleeT = 4;
        ped.fleeFromX = x;
        ped.fleeFromY = y;
        n += 1;
      }
    }
    state.fled += n;
    return n;
  }

  function stepWalk(ped, dt) {
    // Walk along the current direction; at a junction, sometimes turn.
    ped.turnT -= dt;
    if (ped.turnT <= 0) {
      ped.turnT = 3 + Math.random() * 7;
      // Turn left or right at a junction (swap axes, keep moving).
      if (Math.random() < 0.45) {
        const nx = ped.dirY;
        const ny = ped.dirX * (Math.random() < 0.5 ? 1 : -1);
        ped.dirX = nx;
        ped.dirY = ny;
      }
    }
    const step = ped.walkSpeed * dt;
    const dx = ped.dirX * step;
    const dy = ped.dirY * step;
    if (game && game.world && typeof game.world.tryMove === 'function') {
      const moved = game.world.tryMove(ped.x, ped.y, dx, dy, 8);
      ped.x = moved.x;
      ped.y = moved.y;
      if (moved.hitX) ped.dirX = -ped.dirX;
      if (moved.hitY) ped.dirY = -ped.dirY;
    } else {
      const nx = ped.x + dx, ny = ped.y + dy;
      if (!blockedAt(game, nx, ny)) { ped.x = nx; ped.y = ny; }
      else { ped.dirX = -ped.dirX; ped.dirY = -ped.dirY; }
    }
    ped.speed = ped.walkSpeed;
    ped.angle = Math.atan2(ped.dirY, ped.dirX);
    // A paired partner keeps its side offset from its partner.
    if (ped.pairedWith && !ped.pairedWith.dead) {
      const partner = ped.pairedWith;
      const wantX = partner.x + (partner.dirY === 0 ? 0 : PEDESTRIAN_PAIR_OFFSET);
      const wantY = partner.y + (partner.dirY === 0 ? PEDESTRIAN_PAIR_OFFSET : 0);
      ped.x += (wantX - ped.x) * Math.min(1, dt * 4);
      ped.y += (wantY - ped.y) * Math.min(1, dt * 4);
      ped.dirX = partner.dirX;
      ped.dirY = partner.dirY;
    }
  }

  function stepFlee(ped, dt) {
    ped.fleeT -= dt;
    if (ped.fleeT <= 0) {
      ped.state = 'walk';
      ped.fleeing = false;
      ped.speed = ped.walkSpeed;
      return;
    }
    const away = Math.atan2(ped.y - ped.fleeFromY, ped.x - ped.fleeFromX);
    const step = PEDESTRIAN_FLEE_SPEED * dt;
    const dx = Math.cos(away) * step;
    const dy = Math.sin(away) * step;
    if (game && game.world && typeof game.world.tryMove === 'function') {
      const moved = game.world.tryMove(ped.x, ped.y, dx, dy, 8);
      ped.x = moved.x;
      ped.y = moved.y;
    } else {
      const nx = ped.x + dx, ny = ped.y + dy;
      if (!blockedAt(game, nx, ny)) { ped.x = nx; ped.y = ny; }
    }
    ped.speed = PEDESTRIAN_FLEE_SPEED;
    ped.angle = away;
  }

  // What scares a pedestrian this frame: a fresh gunshot, a speeding
  // car close by, or Rook sprinting straight at them on foot.
  function checkScares(ped) {
    if (ped.state === 'flee') return;
    const gs = game && game.lastGunshot;
    if (gs && Math.hypot(ped.x - gs.x, ped.y - gs.y) < PEDESTRIAN_SCARE_RADIUS) {
      ped.state = 'flee';
      ped.fleeing = true;
      ped.fleeT = 4;
      ped.fleeFromX = gs.x;
      ped.fleeFromY = gs.y;
      state.fled += 1;
      return;
    }
    for (const car of game && game.cars ? game.cars : []) {
      if (!car || car.wrecked) continue;
      const d = Math.hypot(ped.x - car.x, ped.y - car.y);
      if (d < PEDESTRIAN_CAR_SCARE_RADIUS && Math.abs(car.speed || 0) > PEDESTRIAN_CAR_SCARE_SPEED) {
        ped.state = 'flee';
        ped.fleeing = true;
        ped.fleeT = 3;
        ped.fleeFromX = car.x;
        ped.fleeFromY = car.y;
        state.fled += 1;
        return;
      }
    }
  }

  function maintainPopulation() {
    const p = playerPos();
    // Despawn the far away, then top back up near the player.
    for (let i = state.list.length - 1; i >= 0; i--) {
      const ped = state.list[i];
      if (!ped) continue;
      if (Math.hypot(ped.x - p.x, ped.y - p.y) > PEDESTRIAN_DESPAWN_DISTANCE) {
        if (ped.pairedWith) ped.pairedWith.pairedWith = null;
        state.list.splice(i, 1);
      }
    }
    let guard = 0;
    while (state.list.length < PEDESTRIAN_TARGET_COUNT && guard++ < 8) {
      if (!spawnNearPlayer()) break;
    }
    syncList();
  }

  function update(dt) {
    const step = Math.max(0, Math.min(0.1, Number(dt) || 0.016));
    if (!game || !game.state || game.state === 'playing') {
      for (const ped of state.list) {
        if (!ped || ped.dead) continue;
        checkScares(ped);
        if (ped.state === 'flee') stepFlee(ped, step);
        else stepWalk(ped, step);
      }
      maintainPopulation();
    }
    return state;
  }

  function snapshot() {
    let fleeing = 0;
    let paired = 0;
    for (const ped of state.list) {
      if (ped.fleeing) fleeing += 1;
      if (ped.paired) paired += 1;
    }
    return {
      count: state.list.length,
      fleeing,
      paired,
      spawned: state.spawned,
      fled: state.fled,
      pairsFormed: state.pairsFormed,
    };
  }

  return {
    state,
    list: state.list,
    update,
    spawnPedestrian,
    spawnNearPlayer,
    scarePedestrians,
    maintainPopulation,
    snapshot,
  };
}

export default createPedestrians;

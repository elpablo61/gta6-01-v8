// autopilot.js — Crescent Bay mission autopilot (fresh from prose spec §2, §4).
//
// Drives the playtest suites and the screenshot poses, so it must handle
// every system: go-to, chase, escape, shootout, garage, helicopter.
//
// Contract with the rest of the game (the ONLY coupling):
//   - The autopilot writes ONE object every frame: G.autopilot.input
//     { up, down, left, right, sprint, interact, shoot, aimX, aimY,
//       weapon1, weapon2, weapon3, cycleWeapon, radio }.
//   - player.js reads that object instead of the keyboard whenever
//     G.autopilot.active is true. One input source per frame, autopilot
//     wins when active — the manual/autopilot conflict from the
//     builder-1 notes cannot happen.
//   - The mission module sets the objective with setObjective().
//     Objective: { type, x, y, ... } where type is one of:
//       'goto'     drive/walk to (x, y)
//       'chase'    ram the moving target car at (x, y) — see G.courier
//       'escape'   drive to the Spray Shop (G.sprayShop {x,y})
//       'shootout' clear enemies, then reach (x, y) — see G.enemies
//       'garage'   drive to the Fixer Garage, buy, then go to (x, y)
//       'idle'     hold position (still never idle under the heli spotlight)
//   - The game exposes what the autopilot needs on G: player, traffic,
//     combat, police, helicopter, garage, sprayShop, courier, enemies,
//     dialogOpen (mission dialog waiting for E).
//
// Rules baked in from the spec (do not "improve" them):
//   - On-foot walk target is memoized: recompute only when the target
//     moves > 120 (spec §1 / §9.1 — never chase a moving target forever).
//   - Leave a slow car for a much faster parked car nearby, only when
//     the current car's top speed is < 350 (go-to) or < 430 (chase) and
//     a faster parked car is within 200 (go-to) / 320 (chase). Switching
//     is a theft that adds heat, so never switch for a marginal gain.
//   - Chase: cruise at full speed vs the courier's 380; a ram hit counts
//     within 70 units while speed > 120; each hit cuts the courier's
//     cruise to 55% (the mission module owns the hit counting).
//   - Escape: drive to the Spray Shop.
//   - Shootout: walk straight to the nearest enemy until in range,
//     shoot in aimed bursts every 0.45s (never spray), pick up arena
//     ammo when the current weapon's ammo is <= 6, pick up a better
//     weapon crate when one is in the arena (m10).
//   - Garage (m11): drive to the Fixer Garage, open the menu, buy the
//     cheapest available upgrade, close, continue to the checkpoints.
//   - Helicopter (m9/m12): ignore it except by never stopping under the
//     spotlight — keep moving toward the objective.
//   - Mission dialog: pressing E to accept runs BEFORE the car search
//     (spec §9.1 — the dialog/autopilot deadlock fix).
//   - Route-finding includes the FIRST junction as the first waypoint
//     (never cut diagonally across a block).
//
// Context object G (only what this module reads): player, traffic,
// combat, police, helicopter { active, spotlightOnPlayer }, garage
// { x, y, open(), buyCheapest(), close(), isOpen }, sprayShop { x, y },
// courier { x, y }, enemies (array or function), dialogOpen (bool),
// mission { type, ... } (optional; setObjective overrides it).

export const WORLD = 3200;
export const ROAD_STEP = 400;
export const ROAD_FIRST = 200;
export const ROAD_COUNT = 8;

function roadCoord(i) { return ROAD_FIRST + i * ROAD_STEP; }
function nearestRoadIndex(v) {
  return Math.max(0, Math.min(ROAD_COUNT - 1, Math.round((v - ROAD_FIRST) / ROAD_STEP)));
}
function distToRoad(v) {
  return Math.abs(v - roadCoord(nearestRoadIndex(v)));
}
function angleDiff(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

// BFS over the 8x8 junction grid. Junctions are indexed [col][row]
// consistently everywhere in this file (the transposed-index infinite
// loop from the builder-1 notes is designed out: col is always x).
function findRoute(fromCol, fromRow, toCol, toRow) {
  const key = (c, r) => r * ROAD_COUNT + c;
  const prev = new Map();
  const queue = [[fromCol, fromRow]];
  prev.set(key(fromCol, fromRow), null);
  while (queue.length > 0) {
    const [c, r] = queue.shift();
    if (c === toCol && r === toRow) break;
    const neighbours = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]];
    for (const [nc, nr] of neighbours) {
      if (nc < 0 || nc >= ROAD_COUNT || nr < 0 || nr >= ROAD_COUNT) continue;
      const k = key(nc, nr);
      if (prev.has(k)) continue;
      prev.set(k, [c, r]);
      queue.push([nc, nr]);
    }
  }
  // Walk the parent chain back from the destination.
  const path = [];
  let cur = [toCol, toRow];
  let guard = 0;
  while (cur && guard++ < 200) {
    path.unshift(cur);
    cur = prev.get(key(cur[0], cur[1]));
  }
  return path.map(([c, r]) => ({ x: roadCoord(c), y: roadCoord(r) }));
}

function emptyInput() {
  return {
    up: false, down: false, left: false, right: false, sprint: false,
    interact: false, shoot: false, aimX: 0, aimY: 0,
    weapon1: false, weapon2: false, weapon3: false, cycleWeapon: false,
    radio: false,
  };
}

export function createAutopilot(G) {
  const game = G || {};
  const api = {
    active: false,
    input: emptyInput(),
    objective: null,
    status: 'idle',
  };

  // Memoized on-foot walk target (spec: recompute only when it moves >120).
  let walkTarget = null; // { x, y, tx, ty }
  // Memoized driving route.
  let route = null; // array of { x, y }
  let routeDest = null; // { x, y } the route was built for
  // Shootout burst timer: fire 0.15s, rest until 0.45s have passed.
  let burstTimer = 0;
  let burstFiring = false;
  // Garage step state.
  let garageStep = 'drive'; // drive | open | buy | close | done
  let garageWait = 0;

  function resetMemo() {
    walkTarget = null;
    route = null;
    routeDest = null;
    garageStep = 'drive';
    garageWait = 0;
  }

  function playerCar() {
    const p = game.player;
    if (!p || p.onFoot || !p.car) return null;
    return p.car;
  }

  function topSpeedOf(car) {
    if (!car) return 0;
    const base = (car.type && car.type.topSpeed) || 300;
    const up = car.upgrades || {};
    return base * (1 + 0.15 * (up.engine || 0));
  }

  // Find a faster parked car worth switching to (spec §1 rule).
  function fasterParkedNearby(mode) {
    const traffic = game.traffic;
    if (!traffic || typeof traffic.nearestParked !== 'function') return null;
    const p = game.player;
    if (!p) return null;
    const limit = mode === 'chase' ? 430 : 350;
    const range = mode === 'chase' ? 320 : 200;
    const current = topSpeedOf(playerCar());
    if (current >= limit) return null;
    const p2 = game.player;
    const car = traffic.nearestParked(p2.x, p2.y, range);
    if (!car) return null;
    if (topSpeedOf(car) <= current + 40) return null; // never switch for a marginal gain
    return car;
  }

  function rebuildRouteIfNeeded(fromX, fromY, toX, toY) {
    if (routeDest && Math.hypot(toX - routeDest.x, toY - routeDest.y) < 100 && route && route.length > 0) {
      return route;
    }
    const from = { col: nearestRoadIndex(fromX), row: nearestRoadIndex(fromY) };
    const to = { col: nearestRoadIndex(toX), row: nearestRoadIndex(toY) };
    const path = findRoute(from.col, from.row, to.col, to.row);
    // First waypoint is the FIRST junction (never cut diagonally across
    // a block): the path already starts at the nearest junction, and we
    // prepend the car's nearest road point when it is off-road.
    route = path;
    routeDest = { x: toX, y: toY };
    return route;
  }

  // Drive the player's car toward (tx, ty) via the road graph.
  // Returns true when arrived (within 70).
  function driveTo(tx, ty, dt, input, cruise) {
    const p = game.player;
    const car = playerCar();
    if (!p || !car) return false;
    const dist = Math.hypot(tx - p.x, ty - p.y);
    if (dist < 70) return true;

    // Off-road recovery: head for the nearest road point first, then
    // the nearest junction (never aim at a centreline point outside
    // the world edge).
    let waypoint;
    if (distToRoad(p.x) > 40 && distToRoad(p.y) > 40) {
      waypoint = {
        x: roadCoord(nearestRoadIndex(p.x)),
        y: roadCoord(nearestRoadIndex(p.y)),
      };
      // Pick the nearer axis so we do not cut a corner.
      if (Math.abs(p.x - waypoint.x) < Math.abs(p.y - waypoint.y)) waypoint.y = p.y;
      else waypoint.x = p.x;
    } else {
      const path = rebuildRouteIfNeeded(p.x, p.y, tx, ty);
      // Drop waypoints we have passed.
      while (path.length > 1 && Math.hypot(path[0].x - p.x, path[0].y - p.y) < 60) path.shift();
      waypoint = path.length > 0 ? path[0] : { x: tx, y: ty };
      if (path.length === 1 || (path.length === 0)) {
        // Last leg: the destination itself (may be off the road grid).
        if (Math.hypot(path.length ? path[0].x - p.x : 0, path.length ? path[0].y - p.y : 0) < 120) {
          waypoint = { x: tx, y: ty };
        }
      }
      if (path.length === 0) waypoint = { x: tx, y: ty };
      else if (path.length === 1 && Math.hypot(path[0].x - p.x, path[0].y - p.y) < 120) {
        waypoint = { x: tx, y: ty };
      }
    }

    const desired = Math.atan2(waypoint.y - p.y, waypoint.x - p.x);
    const diff = angleDiff(car.angle, desired);
    const speed = Math.abs(car.speed || 0);
    // Brake ahead of sharp turns; a turn sharper than ~52 deg (|diff| >
    // 0.9) stops the car and rotates it in place (player.js owns the
    // rotate-in-place behaviour — here we just cut throttle and steer).
    if (Math.abs(diff) > 0.9) {
      input.up = false;
      input.down = speed > 30;
    } else if (Math.abs(diff) > 0.45 && speed > 200) {
      input.up = false; // ease off before the turn
    } else {
      input.up = true;
    }
    if (cruise && speed > cruise) input.up = false;
    input.left = diff < -0.08;
    input.right = diff > 0.08;
    // U-turns crawl at speed 60: if we are basically facing away from
    // the waypoint, do not floor it.
    if (Math.abs(diff) > 2.4) input.up = speed < 60;
    return false;
  }

  // Walk on foot toward (tx, ty). Follows the road graph to the nearest
  // road point, then the last leg on foot. Memoized (spec §1).
  function walkTo(tx, ty, dt, input) {
    const p = game.player;
    if (!p) return false;
    if (!walkTarget || Math.hypot(tx - walkTarget.tx, ty - walkTarget.ty) > 120) {
      walkTarget = { x: tx, y: ty, tx, ty };
    }
    const dist = Math.hypot(tx - p.x, ty - p.y);
    if (dist < 26) return true;
    let wx = tx;
    let wy = ty;
    if (dist > 220) {
      // Far leg: walk to the nearest road point first.
      const rx = roadCoord(nearestRoadIndex(p.x));
      const ry = roadCoord(nearestRoadIndex(p.y));
      if (Math.abs(p.x - rx) < Math.abs(p.y - ry)) { wx = rx; wy = p.y; }
      else { wx = p.x; wy = ry; }
      if (Math.hypot(wx - p.x, wy - p.y) < 30) { wx = tx; wy = ty; }
    }
    const dx = wx - p.x;
    const dy = wy - p.y;
    input.up = dy < -8;
    input.down = dy > 8;
    input.left = dx < -8;
    input.right = dx > 8;
    input.sprint = dist > 120;
    return false;
  }

  function liveEnemies() {
    if (typeof game.enemies === 'function') return game.enemies();
    if (Array.isArray(game.enemies)) return game.enemies;
    if (game.mission && Array.isArray(game.mission.enemies)) return game.mission.enemies;
    return [];
  }

  function nearestEnemy() {
    const p = game.player;
    const list = liveEnemies().filter((e) => e && typeof e.hp === 'number' && e.hp > 0);
    let best = null;
    let bestD = Infinity;
    for (const e of list) {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best ? { enemy: best, dist: bestD } : null;
  }

  function nearestAmmoPickup() {
    const combat = game.combat;
    if (!combat || typeof combat.ammoPickups !== 'function') return null;
    const p = game.player;
    let best = null;
    let bestD = Infinity;
    for (const pk of combat.ammoPickups()) {
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bestD) { best = pk; bestD = d; }
    }
    return best;
  }

  function nearestWeaponCrate() {
    const combat = game.combat;
    if (!combat || typeof combat.crates !== 'function') return null;
    const p = game.player;
    let best = null;
    let bestD = Infinity;
    for (const c of combat.crates()) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  // Keep moving under the helicopter spotlight: if the frame would
  // otherwise be idle and the spotlight is on Rook, creep forward.
  function heliNudge(input) {
    const heli = game.helicopter;
    if (!heli || !heli.spotlightOnPlayer) return;
    if (!input.up && !input.down && !input.left && !input.right) {
      const p = game.player;
      if (p && !p.onFoot && p.car) input.up = true;
      else input.up = true; // on foot: keep walking toward the objective
    }
  }

  function updateShootout(dt, input, obj) {
    const p = game.player;
    const combat = game.combat;
    // On foot for a shootout: step out of the car first.
    if (p && !p.onFoot) {
      input.interact = true;
      api.status = 'shootout: exiting car';
      return;
    }
    // Low ammo: grab the nearest arena ammo pickup first.
    if (combat && combat.currentAmmo() <= 6) {
      const pk = nearestAmmoPickup();
      if (pk) {
        api.status = 'shootout: fetching ammo';
        walkTo(pk.x, pk.y, dt, input);
        return;
      }
    }
    // A better weapon crate in the arena (m10): pick it up first.
    if (combat && combat.currentWeapon() === 'pistol') {
      const crate = nearestWeaponCrate();
      if (crate && Math.hypot(crate.x - p.x, crate.y - p.y) < 500) {
        api.status = 'shootout: fetching weapon crate';
        if (walkTo(crate.x, crate.y, dt, input)) {
          // Standing on it — combat.update collects it next frame.
        }
        return;
      }
    }
    const found = nearestEnemy();
    if (!found) {
      // Arena clear: head for the exit marker.
      api.status = 'shootout: arena clear, moving to exit';
      if (obj && typeof obj.x === 'number') walkTo(obj.x, obj.y, dt, input);
      return;
    }
    const { enemy, dist } = found;
    const range = combat ? combat.currentWeaponDef().range * 0.8 : 300;
    if (dist > range) {
      api.status = 'shootout: closing on enemy';
      walkTo(enemy.x, enemy.y, dt, input);
      return;
    }
    // In range: aimed bursts every 0.45s (never spray).
    burstTimer -= dt;
    if (burstTimer <= 0) {
      burstTimer = 0.45;
      burstFiring = true;
    }
    if (burstFiring) {
      input.shoot = true;
      input.aimX = enemy.x;
      input.aimY = enemy.y;
      // One short burst, then stop firing until the next cycle.
      if (burstTimer < 0.30) burstFiring = false;
    }
    api.status = 'shootout: firing';
  }

  function updateGarage(dt, input, obj) {
    const garage = game.garage;
    const p = game.player;
    if (!garage) { api.status = 'garage: no garage in game'; return; }
    if (garageStep === 'drive') {
      api.status = 'garage: driving to Fixer Garage';
      const arrived = p && !p.onFoot
        ? driveTo(garage.x, garage.y, dt, input)
        : walkTo(garage.x, garage.y, dt, input);
      if (arrived || (p && Math.hypot(garage.x - p.x, garage.y - p.y) < 80)) {
        if (p && !p.onFoot) input.interact = true; // step out
        garageStep = 'open';
        garageWait = 0.5;
      }
      return;
    }
    if (garageStep === 'open') {
      garageWait -= dt;
      if (garageWait <= 0) {
        if (typeof garage.open === 'function') garage.open();
        garageStep = 'buy';
      }
      return;
    }
    if (garageStep === 'buy') {
      if (typeof garage.buyCheapest === 'function') {
        const bought = garage.buyCheapest();
        api.status = bought ? `garage: bought ${bought}` : 'garage: nothing affordable';
      }
      garageStep = 'close';
      return;
    }
    if (garageStep === 'close') {
      if (typeof garage.close === 'function') garage.close();
      garageStep = 'done';
      return;
    }
    // Done: continue to the checkpoints in the objective.
    api.status = 'garage: upgrade done, continuing';
    if (obj && typeof obj.x === 'number') {
      if (p && p.onFoot) {
        const car = fasterParkedNearby('goto');
        if (car) { walkTo(car.x, car.y, dt, input); if (Math.hypot(car.x - p.x, car.y - p.y) < 60) input.interact = true; return; }
        walkTo(obj.x, obj.y, dt, input);
      } else {
        driveTo(obj.x, obj.y, dt, input);
      }
    }
  }

  function updateGoto(dt, input, obj, mode) {
    const p = game.player;
    if (!p) return;
    const tx = obj.x;
    const ty = obj.y;
    // On foot: prefer a much faster parked car nearby (spec §1 rule).
    if (p.onFoot) {
      const better = fasterParkedNearby(mode);
      if (better) {
        api.status = `${mode}: switching to faster parked car`;
        if (walkTo(better.x, better.y, dt, input)) input.interact = true;
        else if (Math.hypot(better.x - p.x, better.y - p.y) < 60) input.interact = true;
        return;
      }
      // No car worth taking: walk (memoized target).
      api.status = `${mode}: walking`;
      walkTo(tx, ty, dt, input);
      return;
    }
    api.status = `${mode}: driving`;
    driveTo(tx, ty, dt, input, mode === 'chase' ? 520 : undefined);
  }

  return {
    active: api.active,
    input: api.input,
    status: api.status,
    objective: api.objective,

    enable() { api.active = true; this.active = true; },
    disable() { api.active = false; this.active = false; this.input = emptyInput(); api.input = this.input; },

    setObjective(obj) {
      api.objective = obj || null;
      this.objective = api.objective;
      resetMemo();
      if (obj && obj.type === 'garage') garageStep = 'drive';
    },

    update(dt) {
      const input = emptyInput();
      api.input = input;
      this.input = input;
      if (!api.active) return input;

      const obj = api.objective;
      const p = game.player;

      // 1. Dialog first: accept a mission dialog with E before any car
      // search (spec §9.1 deadlock fix).
      if (game.dialogOpen) {
        input.interact = true;
        api.status = 'accepting dialog';
        this.status = api.status;
        heliNudge(input);
        return input;
      }

      if (!obj || !p) {
        api.status = 'idle';
        this.status = api.status;
        heliNudge(input);
        return input;
      }

      switch (obj.type) {
        case 'chase': {
          // Chase the courier car itself (it moves — walk target memo
          // handles the moving target, recompute only past 120).
          const c = game.courier || (typeof obj.x === 'number' ? obj : null);
          const tx = c ? c.x : obj.x;
          const ty = c ? c.y : obj.y;
          if (p.onFoot) {
            const better = fasterParkedNearby('chase');
            if (better) {
              api.status = 'chase: switching to faster parked car';
              if (walkTo(better.x, better.y, dt, input)) input.interact = true;
              else if (Math.hypot(better.x - p.x, better.y - p.y) < 60) input.interact = true;
              break;
            }
            // No car in range: walk to the courier's nearest road point
            // instead of chasing the moving car on foot forever.
            api.status = 'chase: walking to courier road point';
            walkTo(tx, ty, dt, input);
            break;
          }
          api.status = 'chase: ramming courier';
          // Full speed at the courier; driveTo caps nothing here — the
          // car tops out at its own top speed, chase cruise 520.
          driveTo(tx, ty, dt, input, 520);
          break;
        }
        case 'escape': {
          const shop = game.sprayShop || obj;
          api.status = 'escape: driving to Spray Shop';
          if (p.onFoot) {
            const better = fasterParkedNearby('goto');
            if (better) {
              if (walkTo(better.x, better.y, dt, input)) input.interact = true;
              else if (Math.hypot(better.x - p.x, better.y - p.y) < 60) input.interact = true;
              break;
            }
            walkTo(shop.x, shop.y, dt, input);
          } else {
            driveTo(shop.x, shop.y, dt, input);
          }
          break;
        }
        case 'shootout':
          updateShootout(dt, input, obj);
          break;
        case 'garage':
          updateGarage(dt, input, obj);
          break;
        case 'goto':
        default:
          updateGoto(dt, input, obj, 'goto');
          break;
      }

      // Helicopter rule: never stop under the spotlight.
      heliNudge(input);
      this.status = api.status;
      return input;
    },
  };
}

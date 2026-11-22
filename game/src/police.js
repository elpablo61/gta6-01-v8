// Crescent Bay — wanted heat and the police department.
//
// The wanted system is a heat meter, not a score. Crimes pour heat in;
// hiding lets it drain away. Stars are just thresholds read off the
// heat, so every part of the game (HUD, spawns, helicopter, missions)
// agrees on how hot Rook is by looking at one number.
//
// Police behaviour, in one paragraph: foot cops appear at one star and
// patrol cars join from two stars; roadblocks appear at four and five.
// Pursuers drive the road graph, their routes recomputed every second
// or two, and they spawn ahead of Rook so a chase feels like an
// ambush, not a tail that materialises behind him. During a shootout
// they hold a ring around the arena instead of piling onto one spot.
// An arrest is deliberately hard to trigger by accident: a foot cop
// must stay within thirty units of a slow, on-foot Rook for 1.2 seconds
// without interruption, and running away breaks the timer. The Spray
// Shop (repaint garage) drains heat fast, and patrol cars will not
// ram their way through its forecourt — they brake and reverse clear
// of it. Police are the only ones in the city with flashing red-blue
// light bars; red is reserved for danger.

import {
  WANTED_THRESHOLDS,
  WANTED_MAX_HEAT,
  WANTED_HIDE_DISTANCE,
  WANTED_HIDE_SECONDS,
  SPRAY_SHOP,
  CAR_TYPES,
  WORLD_W,
  WORLD_H,
} from './config.js';

// ---------------------------------------------------------------------------
// Wanted heat
// ---------------------------------------------------------------------------

// Advance the wanted meter by one frame. `sense` describes what the
// police can currently see, and is supplied by the main loop:
//
//   sense.nearestPoliceDistance — distance to the closest cop, or
//     Infinity when no police exist at all.
//   sense.spotlightOnRook — true while the police helicopter's
//     spotlight is on Rook; hiding is impossible under it.
//   sense.inSprayShop — true while Rook is inside the Spray Shop
//     radius; heat drains fast there instead of slowly.
//
// Heat only decays while Rook has been out of police sight for a full
// hiding stretch. Any police officer coming close restarts that clock.
export function updateWantedHeat(wanted, dt, sense) {
  const see = sense || {};
  const nearest = see.nearestPoliceDistance == null
    ? Infinity
    : see.nearestPoliceDistance;
  const underSpotlight = !!see.spotlightOnRook;

  if (see.inSprayShop) {
    wanted.heat = Math.max(0, wanted.heat - SPRAY_SHOP.drainPerSecond * dt);
    wanted.hiddenSeconds = 0;
  } else if (nearest > WANTED_HIDE_DISTANCE && !underSpotlight) {
    wanted.hiddenSeconds += dt;
    if (wanted.hiddenSeconds >= WANTED_HIDE_SECONDS) {
      // Slow bleed once Rook has genuinely shaken the pursuit.
      wanted.heat = Math.max(0, wanted.heat - 6 * dt);
    }
  } else {
    wanted.hiddenSeconds = 0;
  }

  wanted.heat = Math.max(0, Math.min(WANTED_MAX_HEAT, wanted.heat));
  wanted.stars = starsFromHeat(wanted.heat);
  return wanted;
}

// The star thresholds, mirrored from config so the outline and the
// HUD read the same numbers. Index = stars (0–5).
export const WANTED_STAR_THRESHOLDS = [0, 12, 30, 52, 74, 92];

export function starsFromHeat(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED_STAR_THRESHOLDS.length; i++) {
    if (heat >= WANTED_STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

// A fresh wanted meter: cold, no stars, no hidden time banked.
export function createWantedState() {
  return {
    heat: 0,
    stars: 0,
    hiddenSeconds: 0,
    // How long the current arrest attempt has held, in seconds.
    arrestHoldSeconds: 0,
  };
}

// Heat added by each kind of crime. Stealing a car is a small bump;
// killing a cop is a large one. Missions add their own cover heat
// separately by setting `heat` directly after the mission starts.
export const CRIME_HEAT = {
  stealCar: 8,
  shoot: 6,
  hitPedestrian: 10,
  killCop: 18,
  ramPoliceCar: 12,
};

export function addCrimeHeat(wanted, kind, amount) {
  const bump = amount != null
    ? amount
    : (CRIME_HEAT[kind] || 0);
  wanted.heat = Math.max(0, Math.min(WANTED_MAX_HEAT, wanted.heat + bump));
  wanted.stars = starsFromHeat(wanted.heat);
  // Any fresh crime breaks a hiding streak.
  wanted.hiddenSeconds = 0;
  return wanted;
}

// Set the wanted level directly (used by missions that start Rook
// already hot, e.g. a cover level of 3 stars). The assignment happens
// after the mission itself has started, so mission-start heat does
// not stack on top of it by accident.
export function setWantedHeat(wanted, heat) {
  wanted.heat = Math.max(0, Math.min(WANTED_MAX_HEAT, heat));
  wanted.stars = starsFromHeat(wanted.heat);
  wanted.hiddenSeconds = 0;
  return wanted;
}

// ---------------------------------------------------------------------------
// Police department
// ---------------------------------------------------------------------------

// How many pursuers each wanted level is allowed. The cap keeps a
// five-star chase frantic without flooding the streets.
export function pursuerBudget(stars) {
  return {
    footCops: stars >= 1 ? Math.min(2 + stars, 6) : 0,
    patrolCars: stars >= 2 ? Math.min(stars - 1, 4) : 0,
    roadblocks: stars >= 4 ? (stars >= 5 ? 2 : 1) : 0,
  };
}

// A fresh police department. `router` is an optional helper supplied
// by the main loop / world module:
//
//   router.findRoute(fromX, fromY, toX, toY) -> [{x, y}, ...] waypoints
//   router.nearestRoadPoint(x, y) -> {x, y} nearest point on a road
//
// When no router is supplied, pursuers steer straight at Rook —
// good enough for a smoke test, never the shipped behaviour.
export function createPoliceDepartment(router) {
  return {
    router: router || null,
    footCops: [],
    patrolCars: [],
    roadblocks: [],
    // Staggered route-recompute clock, so not every pursuer asks
    // for a new route on the same frame.
    routeTimer: 0,
    spawnCooldown: 0,
    // Seconds since the last roadblock was placed.
    roadblockTimer: 0,
    nextCopId: 1,
  };
}

function clampToWorld(x, y) {
  return {
    x: Math.max(40, Math.min(WORLD_W - 40, x)),
    y: Math.max(40, Math.min(WORLD_H - 40, y)),
  };
}

function distance(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

// Pick a spawn point in FRONT of Rook — ahead along his heading, on
// the road if the router can place it there — so police arrive as an
// ambush instead of appearing in his rear-view mirror.
function spawnPointAhead(player, aheadDistance, sideOffset) {
  const heading = player.angle || 0;
  const px = player.x + Math.cos(heading) * aheadDistance
    - Math.sin(heading) * (sideOffset || 0);
  const py = player.y + Math.sin(heading) * aheadDistance
    + Math.cos(heading) * (sideOffset || 0);
  return clampToWorld(px, py);
}

function makeFootCop(dept, x, y) {
  return {
    id: dept.nextCopId++,
    kind: 'foot',
    x, y,
    angle: 0,
    speed: 0,
    // Foot cops jog at roughly a sprinting pedestrian's pace.
    topSpeed: 170,
    route: [],
    routeIndex: 0,
    routeAge: 0,
    // Pistol only — police never carry anything heavier.
    weapon: 'pistol',
    fireCooldown: 0,
    // Seconds this cop has held the arrest position, in a row.
    arrestHold: 0,
    // Perimeter slot: the angle around the shootout ring this cop
    // is assigned to hold.
    ringAngle: Math.random() * Math.PI * 2,
    flashPhase: Math.random() * Math.PI * 2,
  };
}

function makePatrolCar(dept, x, y) {
  return {
    id: dept.nextCopId++,
    kind: 'patrol',
    x, y,
    angle: 0,
    speed: 0,
    topSpeed: CAR_TYPES.police.topSpeed,
    accel: CAR_TYPES.police.accel,
    route: [],
    routeIndex: 0,
    routeAge: 0,
    weapon: 'pistol',
    fireCooldown: 0,
    // Reversing clear of the Spray Shop forecourt.
    reversing: false,
    reverseTimer: 0,
    // Seconds of contact damage banked against the player's car.
    touchDamage: 0,
    ringAngle: Math.random() * Math.PI * 2,
    flashPhase: Math.random() * Math.PI * 2,
  };
}

function makeRoadblock(x, y, angle) {
  return {
    x, y,
    angle,
    // Two parked patrol cars nose-to-tail across the road, drawn
    // as one solid barrier.
    width: 150,
  };
}

// Keep the department at the strength the current wanted level
// allows: spawn what is missing, retire what is no longer wanted.
// Spawns happen ahead of Rook; despawns happen far away, off-screen,
// so the player never watches a cop pop out of existence.
function maintainStrength(dept, player, stars, dt) {
  const budget = pursuerBudget(stars);
  dept.spawnCooldown -= dt;

  if (dept.spawnCooldown <= 0) {
    if (dept.footCops.length < budget.footCops) {
      const spot = spawnPointAhead(player, 420 + dept.footCops.length * 90, 60);
      dept.footCops.push(makeFootCop(dept, spot.x, spot.y));
      dept.spawnCooldown = 0.4;
    } else if (dept.patrolCars.length < budget.patrolCars) {
      const spot = spawnPointAhead(player, 560 + dept.patrolCars.length * 140, 0);
      dept.patrolCars.push(makePatrolCar(dept, spot.x, spot.y));
      dept.spawnCooldown = 0.6;
    }
  }

  // Wanted fell: let the extra cops melt away once they are far off.
  while (dept.footCops.length > budget.footCops) {
    const far = dept.footCops
      .map((c, i) => ({ i, d: distance(c.x, c.y, player.x, player.y) }))
      .sort((a, b) => b.d - a.d)[0];
    dept.footCops.splice(far.i, 1);
  }
  while (dept.patrolCars.length > budget.patrolCars) {
    const far = dept.patrolCars
      .map((c, i) => ({ i, d: distance(c.x, c.y, player.x, player.y) }))
      .sort((a, b) => b.d - a.d)[0];
    dept.patrolCars.splice(far.i, 1);
  }

  // Roadblocks only exist at 4–5 stars, placed ahead on Rook's road.
  dept.roadblockTimer -= dt;
  if (budget.roadblocks > 0 && dept.roadblocks.length < budget.roadblocks
    && dept.roadblockTimer <= 0) {
    const spot = spawnPointAhead(player, 700, 0);
    dept.roadblocks.push(makeRoadblock(spot.x, spot.y, player.angle || 0));
    dept.roadblockTimer = 6;
  }
  if (budget.roadblocks === 0) dept.roadblocks.length = 0;
  if (stars === 0) {
    dept.footCops.length = 0;
    dept.patrolCars.length = 0;
    dept.roadblocks.length = 0;
  }
}

// Ask the router for a fresh route for one pursuer, or fall back to a
// direct line when no router is wired in.
function refreshRoute(dept, unit, tx, ty) {
  if (dept.router && dept.router.findRoute) {
    const route = dept.router.findRoute(unit.x, unit.y, tx, ty);
    if (route && route.length > 0) {
      unit.route = route;
      unit.routeIndex = 0;
      unit.routeAge = 0;
      return;
    }
  }
  unit.route = [{ x: tx, y: ty }];
  unit.routeIndex = 0;
  unit.routeAge = 0;
}

function followRoute(unit, dt, topSpeed, arriveRadius) {
  if (!unit.route || unit.routeIndex >= unit.route.length) return false;
  const target = unit.route[unit.routeIndex];
  const dx = target.x - unit.x;
  const dy = target.y - unit.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < arriveRadius) {
    unit.routeIndex++;
    return unit.routeIndex < unit.route.length;
  }
  const wantAngle = Math.atan2(dy, dx);
  let diff = wantAngle - unit.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  unit.angle += Math.max(-2.8 * dt, Math.min(2.8 * dt, diff));
  unit.speed = Math.min(topSpeed, unit.speed + 320 * dt);
  unit.x += Math.cos(unit.angle) * unit.speed * dt;
  unit.y += Math.sin(unit.angle) * unit.speed * dt;
  return true;
}

// The arrest rule, exactly as specified: a foot cop must stay within
// 30 units of a slow, on-foot Rook for 1.2 seconds in a row. Running
// away — or getting in a car — breaks the hold instantly. Returns
// true the frame the arrest completes.
function checkArrest(cop, player, dt) {
  const playerOnFoot = !!player.onFoot;
  const playerSlow = (player.speed || 0) < 60;
  const d = distance(cop.x, cop.y, player.x, player.y);
  if (playerOnFoot && playerSlow && d < 30) {
    cop.arrestHold += dt;
    if (cop.arrestHold >= 1.2) return true;
  } else {
    cop.arrestHold = 0;
  }
  return false;
}

// Update one foot cop: chase Rook on foot, or hold a ring slot around
// a shootout arena when one is active. Returns 'arrested' when the
// arrest rule completes, otherwise null.
function updateFootCop(dept, cop, dt, ctx) {
  const player = ctx.player;
  cop.fireCooldown = Math.max(0, cop.fireCooldown - dt);
  cop.routeAge += dt;

  let tx = player.x;
  let ty = player.y;
  if (ctx.shootoutCenter) {
    // Perimeter behaviour: hold a ring around the arena, never pile
    // onto one spot. Each cop owns one angle on the ring.
    const ring = 260;
    tx = ctx.shootoutCenter.x + Math.cos(cop.ringAngle) * ring;
    ty = ctx.shootoutCenter.y + Math.sin(cop.ringAngle) * ring;
  }

  if (cop.routeAge > 1.5 || !cop.route || cop.routeIndex >= cop.route.length) {
    refreshRoute(dept, cop, tx, ty);
  }
  const moving = followRoute(cop, dt, cop.topSpeed, 24);
  if (!moving) {
    // Close enough to stand and face Rook.
    cop.angle = Math.atan2(player.y - cop.y, player.x - cop.x);
    cop.speed = 0;
  }

  if (!ctx.shootoutCenter) {
    if (checkArrest(cop, player, dt)) return 'arrested';
  } else {
    cop.arrestHold = 0;
  }
  return null;
}

// Update one patrol car: drive the road graph after Rook, brake and
// reverse clear of the Spray Shop forecourt, and hold a perimeter
// ring during a shootout instead of ramming the arena.
function updatePatrolCar(dept, car, dt, ctx) {
  const player = ctx.player;
  car.routeAge += dt;
  car.fireCooldown = Math.max(0, car.fireCooldown - dt);

  const shop = SPRAY_SHOP;
  const shopDistance = distance(car.x, car.y, shop.x, shop.y);
  if (shopDistance < 130 && !car.reversing) {
    // Patrol cars brake and reverse within 130 of the Spray Shop —
    // they will not barge into the repaint garage.
    car.reversing = true;
    car.reverseTimer = 1.4;
  }
  if (car.reversing) {
    car.reverseTimer -= dt;
    car.speed = Math.max(-140, car.speed - 300 * dt);
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    if (car.reverseTimer <= 0 || shopDistance > 190) car.reversing = false;
    return;
  }

  let tx = player.x;
  let ty = player.y;
  if (ctx.shootoutCenter) {
    const ring = 300;
    tx = ctx.shootoutCenter.x + Math.cos(car.ringAngle) * ring;
    ty = ctx.shootoutCenter.y + Math.sin(car.ringAngle) * ring;
  }

  // Recompute the pursuit route every 1–2 seconds (staggered by
  // each car's own route age), never every frame.
  if (car.routeAge > 1.2 + (car.id % 5) * 0.15
    || !car.route || car.routeIndex >= car.route.length) {
    refreshRoute(dept, car, tx, ty);
  }
  followRoute(car, dt, car.topSpeed, 46);

  // Ramming contact with the player's car chips its health at
  // 3 damage per second per car — a nudge, not a demolition.
  if (player.inCar && player.car) {
    const d = distance(car.x, car.y, player.car.x, player.car.y);
    if (d < 52) {
      car.touchDamage += 3 * dt;
      if (car.touchDamage >= 1 && ctx.damagePlayerCar) {
        ctx.damagePlayerCar(Math.floor(car.touchDamage), 'police-ram');
        car.touchDamage = 0;
      }
    } else {
      car.touchDamage = 0;
    }
  }
}

// Advance the whole department one frame. `ctx` carries:
//   player — {x, y, angle, speed, onFoot, inCar, car}
//   wanted — the wanted state (heat/stars)
//   shootoutCenter — {x, y} while a shootout mission is active, else null
//   onArrested — called once when the arrest rule completes
//   damagePlayerCar(amount, source) — optional, for ram damage
// Returns 'arrested' when Rook has been caught, otherwise null.
export function updatePolice(dept, dt, ctx) {
  const player = ctx.player;
  const wanted = ctx.wanted;
  maintainStrength(dept, player, wanted.stars, dt);

  for (const cop of dept.footCops) {
    const result = updateFootCop(dept, cop, dt, ctx);
    if (result === 'arrested') {
      if (ctx.onArrested) ctx.onArrested();
      return 'arrested';
    }
  }
  for (const car of dept.patrolCars) {
    updatePatrolCar(dept, car, dt, ctx);
  }
  return null;
}

// Distance to the nearest police unit, for the hiding check. Infinity
// when no police exist — Rook is free to cool down.
export function nearestPoliceDistance(dept, x, y) {
  let best = Infinity;
  for (const cop of dept.footCops) {
    best = Math.min(best, distance(cop.x, cop.y, x, y));
  }
  for (const car of dept.patrolCars) {
    best = Math.min(best, distance(car.x, car.y, x, y));
  }
  return best;
}

// True while Rook is inside the Spray Shop radius (heat drain zone).
export function insideSprayShop(x, y) {
  return distance(x, y, SPRAY_SHOP.x, SPRAY_SHOP.y) < SPRAY_SHOP.radius;
}

// ---------------------------------------------------------------------------
// Drawing — police are the ONLY flashing red-blue in the game
// ---------------------------------------------------------------------------

// Flashing light bar: red on one side, blue on the other, swapping
// with time. Nothing else in the game draws a red-blue bar, and red
// is otherwise reserved for danger (damage, wanted stars).
export function drawLightBar(ctx, x, y, angle, time, phase) {
  const blink = Math.sin(time * 10 + (phase || 0)) > 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = blink ? '#ff2a2a' : '#2a5aff';
  ctx.fillRect(-14, -7, 12, 5);
  ctx.fillStyle = blink ? '#2a5aff' : '#ff2a2a';
  ctx.fillRect(2, -7, 12, 5);
  // A soft glow so the bar reads at a glance, even small.
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = blink ? '#ff2a2a' : '#2a5aff';
  ctx.beginPath();
  ctx.arc(0, -4, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawPolice(ctx, dept, camera, time) {
  const ox = camera ? -camera.x : 0;
  const oy = camera ? -camera.y : 0;
  ctx.save();
  ctx.translate(ox, oy);

  for (const block of dept.roadblocks) {
    ctx.save();
    ctx.translate(block.x, block.y);
    ctx.rotate(block.angle);
    ctx.fillStyle = '#202840';
    ctx.fillRect(-75, -14, 150, 28);
    ctx.fillStyle = '#e8e8f0';
    ctx.fillRect(-75, -14, 150, 6);
    ctx.fillStyle = '#f0c020';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('POLICE', 0, 4);
    ctx.restore();
  }

  for (const car of dept.patrolCars) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    ctx.fillStyle = '#202840';
    ctx.fillRect(-24, -12, 48, 24);
    ctx.fillStyle = '#e8e8f0';
    ctx.fillRect(-24, -12, 48, 7);
    ctx.fillStyle = '#c8ccd8';
    ctx.fillRect(8, -9, 12, 18);
    ctx.restore();
    drawLightBar(ctx, car.x, car.y, car.angle, time, car.flashPhase);
  }

  for (const cop of dept.footCops) {
    ctx.save();
    ctx.translate(cop.x, cop.y);
    ctx.rotate(cop.angle);
    // Dark navy uniform, white outline so the cop reads on any road.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.fillStyle = '#1c2a4a';
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f0c020';
    ctx.fillRect(-3, -14, 6, 8);
    ctx.restore();
  }

  ctx.restore();
}


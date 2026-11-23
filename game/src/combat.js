// Combat — shooting, bullets, shootout enemies, pickups (Crescent Bay).
//
// Fresh from prose spec §1 + §2 + §3.2. Rook fights on foot with three
// weapons: pistol (18 damage — two hits kill a 36 HP enemy), SMG (fast,
// 10 damage, big magazine), shotgun (slow, 5 pellets x 8 damage, spread,
// short range). Enemies use the pistol only. Weapon switching is instant
// (no animation lock) and lives in weapons.js; this module owns what a
// shot DOES once it leaves the barrel: bullets flying, hitting enemies,
// cops, pedestrians, cars and the police helicopter, muzzle flash,
// particles, and the health / ammo pickups scattered in shootout arenas.
//
// Shared-state contract (everything read defensively; missing fields get
// safe defaults, so the module never throws on a thin game):
//   game.player  { x, y, angle, onFoot, weapon, ammo, health } — Rook.
//   game.weapons { tryFire(angle), enemyShot(x,y,angle), addAmmo(id,n),
//                  hudText() } — the weapon system, when wired.
//   game.enemies — array of { x, y, health, maxHealth, alive }.
//   game.police  — array of cops, or { cops: [], cars: [] }.
//   game.peds / game.pedestrians — array of pedestrians.
//   game.cars    — array of car objects (traffic.js shape).
//   game.helicopter { applyDamage(n) } / { state } — police helicopter.
//   game.pickups — array of { x, y, kind: 'health'|'ammo', weapon, taken }.
//   game.bullets — the bullet list the renderer draws (kept in sync).
//   game.particles — particle list (created when absent).
//   game.world   { isBlocked(x, y) } — building / water collision.
//   game.now / game.time.now — seconds, for muzzle-flash timing.
//   game.audio   { play(name) } — optional sound hook.
//   game.dialog  — while a dialog is open nobody shoots.
// The player calls fireWeapon through game.combat.fireWeapon(game,
// 'player', aimX, aimY) — see player.js. The autopilot aims by setting
// game.input.aimX / aimY and mouseDown, and the same path fires.

import { WEAPON_DEFS } from './weapons.js';
import { damagePlayer, healPlayer, addHeat } from './player.js';
import { damageCar } from './traffic.js';

export const COMBAT_ENEMY_HEALTH = 36;
export const COMBAT_PISTOL_DAMAGE = 18;
export const COMBAT_SMG_DAMAGE = 10;
export const COMBAT_SHOTGUN_PELLETS = 5;
export const COMBAT_SHOTGUN_PELLET_DAMAGE = 8;
export const COMBAT_SHOTGUN_RANGE = 240;
export const COMBAT_ENEMY_FIRE_INTERVAL = 1.5;
export const COMBAT_ENEMY_RANGE = 420;
export const COMBAT_ENEMY_SPEED = 95;
export const COMBAT_ENEMY_ENGAGE_RANGE = 700;
export const COMBAT_ENEMY_STOP_RANGE = 180;
export const COMBAT_BULLET_HIT_RADIUS = 14;
export const COMBAT_HEALTH_PICKUP_AMOUNT = 30;
export const COMBAT_AMMO_PICKUP_AMOUNT = 24;
export const COMBAT_PICKUP_RADIUS = 36;
export const COMBAT_COP_HEALTH = 50;
export const COMBAT_HEAT_PER_COP_HIT = 4;
export const COMBAT_HEAT_PER_COP_KILL = 10;
export const COMBAT_HEAT_PER_PED_HIT = 6;

function nowSeconds(game) {
  if (game && typeof game.now === 'number') return game.now;
  if (game && game.time && typeof game.time.now === 'number') return game.time.now;
  return Date.now() / 1000;
}

function playSound(game, name) {
  if (game && game.audio && typeof game.audio.play === 'function') {
    try { game.audio.play(name); } catch (e) { /* sound is optional */ }
  }
}

function pushParticle(game, x, y, color) {
  if (!game) return;
  if (!Array.isArray(game.particles)) game.particles = [];
  const a = Math.random() * Math.PI * 2;
  game.particles.push({
    x, y,
    vx: Math.cos(a) * 120, vy: Math.sin(a) * 120,
    life: 0.35, maxLife: 0.35, color: color || '#f1c40f', size: 3,
  });
}

function blockedAt(game, x, y) {
  if (x < 12 || x > 3188 || y < 12 || y > 3188) return true;
  if (game && game.world && typeof game.world.isBlocked === 'function') {
    return game.world.isBlocked(x, y, 0);
  }
  return false;
}

function allCops(game) {
  const out = [];
  const police = game ? game.police : null;
  if (Array.isArray(police)) {
    for (const c of police) if (c) out.push(c);
  } else if (police && typeof police === 'object') {
    for (const c of police.cops || []) if (c) out.push(c);
    for (const c of police.cars || []) if (c) out.push(c);
  }
  for (const c of game && game.cops ? game.cops : []) if (c) out.push(c);
  return out;
}

function allPeds(game) {
  if (!game) return [];
  if (Array.isArray(game.peds)) return game.peds;
  if (Array.isArray(game.pedestrians)) return game.pedestrians;
  return [];
}

export function createCombat(game) {
  const state = {
    bullets: [],
    shotsFired: 0,
    hits: 0,
    enemiesKilled: 0,
    copsKilled: 0,
    lastShotAt: -10,
    lastEnemyShotAt: -10,
  };

  function playerObj() {
    return (game && game.player) || null;
  }

  function enemiesList() {
    if (!game) return [];
    if (Array.isArray(game.enemies)) return game.enemies;
    if (game.mission && Array.isArray(game.mission.enemies)) return game.mission.enemies;
    return [];
  }

  function syncBullets() {
    if (game) game.bullets = state.bullets;
  }

  function setMuzzleFlash(x, y) {
    if (!game) return;
    game.muzzleFlash = { x, y, until: nowSeconds(game) + 0.06 };
  }

  function scareNearbyPeds(x, y, radius) {
    for (const ped of allPeds(game)) {
      if (!ped || ped.dead) continue;
      const d = Math.hypot(ped.x - x, ped.y - y);
      if (d < radius) {
        ped.state = 'flee';
        ped.fleeing = true;
        ped.fleeT = 4;
        ped.fleeFromX = x;
        ped.fleeFromY = y;
      }
    }
  }

  // One bullet in flight. kind is the weapon id, fromEnemy marks enemy fire.
  function spawnBullet(x, y, angle, damage, range, speed, kind, fromEnemy) {
    const b = {
      x, y, angle, damage, range, speed: speed || 900,
      kind: kind || 'pistol', fromEnemy: !!fromEnemy,
      traveled: 0, dead: false,
    };
    state.bullets.push(b);
    syncBullets();
    return b;
  }

  // Fire one trigger pull for a shooter. shooter is 'player' or an enemy
  // object { x, y, angle }. aimX/aimY is the world point being aimed at
  // (player only; enemies aim at Rook). Returns true when a shot left.
  function fireWeapon(g, shooter, aimX, aimY) {
    const gg = g || game;
    if (!gg) return false;
    if (gg.dialog && (gg.dialog.open || gg.dialog.visible)) return false;
    const p = playerObj();

    if (shooter === 'player') {
      if (!p || !p.alive || p.onFoot === false) return false;
      const angle = (typeof aimX === 'number' && typeof aimY === 'number')
        ? Math.atan2(aimY - p.y, aimX - p.x)
        : p.angle || 0;
      // The weapon system owns fire rate + ammo; use it when wired.
      if (gg.weapons && typeof gg.weapons.tryFire === 'function') {
        const shots = gg.weapons.tryFire(angle);
        if (!shots || !shots.length) return false;
        for (const s of shots) {
          spawnBullet(s.x, s.y, s.angle, s.damage, s.range, s.speed, s.kind, false);
        }
      } else {
        // Standalone fallback: pistol / SMG / shotgun from the spec defs.
        const id = p.weapon || 'pistol';
        const def = WEAPON_DEFS[id] || WEAPON_DEFS.pistol;
        const now = nowSeconds(gg);
        if (now - state.lastShotAt < def.fireInterval) return false;
        if (!p.ammo || (p.ammo[id] || 0) <= 0) return false;
        state.lastShotAt = now;
        p.ammo[id] -= 1;
        for (let i = 0; i < def.pellets; i++) {
          const jitter = (Math.random() - 0.5) * 2 * def.spread;
          spawnBullet(p.x, p.y, angle + jitter, def.damage, def.range, def.bulletSpeed, id, false);
        }
      }
      state.shotsFired += 1;
      setMuzzleFlash(p.x + Math.cos(angle) * 26, p.y + Math.sin(angle) * 26);
      scareNearbyPeds(p.x, p.y, 260);
      if (gg) gg.lastGunshot = { x: p.x, y: p.y, at: nowSeconds(gg) };
      playSound(gg, 'shoot-' + (p.weapon || 'pistol'));
      return true;
    }

    // Enemy fire: pistol only, one bullet, aimed at Rook with a miss bias.
    if (shooter && typeof shooter.x === 'number') {
      if (!p || !p.alive) return false;
      const aim = Math.atan2(p.y - shooter.y, p.x - shooter.x) + (Math.random() - 0.5) * 0.24;
      if (gg.weapons && typeof gg.weapons.enemyShot === 'function') {
        const s = gg.weapons.enemyShot(shooter.x, shooter.y, aim);
        spawnBullet(s.x, s.y, s.angle, s.damage, s.range, s.speed, s.kind, true);
      } else {
        const def = WEAPON_DEFS.pistol;
        spawnBullet(shooter.x, shooter.y, aim, def.damage, def.range, def.bulletSpeed, 'pistol', true);
      }
      setMuzzleFlash(shooter.x + Math.cos(aim) * 22, shooter.y + Math.sin(aim) * 22);
      playSound(gg, 'shoot-pistol');
      return true;
    }
    return false;
  }

  // A fresh shootout enemy: 36 HP, pistol only, walks at Rook and shoots.
  function spawnEnemy(x, y, opts) {
    const e = {
      x, y,
      angle: 0,
      health: COMBAT_ENEMY_HEALTH,
      maxHealth: COMBAT_ENEMY_HEALTH,
      alive: true,
      fireT: 0.6 + Math.random() * 0.9,
      speed: (opts && opts.speed) || COMBAT_ENEMY_SPEED,
      kind: 'enemy',
    };
    if (!game) return e;
    if (!Array.isArray(game.enemies)) game.enemies = [];
    game.enemies.push(e);
    return e;
  }

  // A ring of enemies around an arena centre — the m8 / m10 / m12 stage.
  // Enemies spawn on roads, never inside building blocks.
  function spawnArenaEnemies(cx, cy, count) {
    const made = [];
    const roads = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + 0.4;
      let x = cx + Math.cos(angle) * 220;
      let y = cy + Math.sin(angle) * 220;
      // Snap onto the nearest road so nobody spawns inside a block.
      let best = null, bestD = Infinity;
      for (const c of roads) {
        const d1 = Math.abs(x - c);
        if (d1 < bestD) { bestD = d1; best = { x: c, y }; }
        const d2 = Math.abs(y - c);
        if (d2 < bestD) { bestD = d2; best = { x, y: c }; }
      }
      if (best) { x = best.x; y = best.y; }
      x = Math.max(60, Math.min(3140, x));
      y = Math.max(60, Math.min(3140, y));
      made.push(spawnEnemy(x, y));
    }
    return made;
  }

  function damageEnemy(enemy, amount) {
    if (!enemy || enemy.alive === false) return false;
    enemy.health -= amount;
    state.hits += 1;
    pushParticle(game, enemy.x, enemy.y, '#e74c3c');
    if (enemy.health <= 0) {
      enemy.health = 0;
      enemy.alive = false;
      state.enemiesKilled += 1;
      playSound(game, 'enemy-down');
      return true;
    }
    return false;
  }

  function nearestEnemy(x, y, maxDistance) {
    let best = null, bestD = maxDistance || Infinity;
    for (const e of enemiesList()) {
      if (!e || e.alive === false || (typeof e.health === 'number' && e.health <= 0)) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function enemiesAlive() {
    let n = 0;
    for (const e of enemiesList()) {
      if (e && e.alive !== false && (typeof e.health !== 'number' || e.health > 0)) n += 1;
    }
    return n;
  }

  function hitHelicopter(x, y, damage) {
    const heli = game && game.helicopter;
    if (!heli) return false;
    const hx = heli.x !== undefined ? heli.x : (heli.state && heli.state.x);
    const hy = heli.y !== undefined ? heli.y : (heli.state && heli.state.y);
    if (typeof hx !== 'number' || typeof hy !== 'number') return false;
    const active = heli.active !== undefined ? heli.active : (heli.state && heli.state.active);
    if (active === false) return false;
    if (Math.hypot(x - hx, y - hy) > 46) return false;
    if (typeof heli.applyDamage === 'function') heli.applyDamage(damage);
    else if (heli.state && typeof heli.state.health === 'number') heli.state.health -= damage;
    return true;
  }

  function stepBullets(dt) {
    const p = playerObj();
    for (const b of state.bullets) {
      if (b.dead) continue;
      const step = b.speed * dt;
      b.x += Math.cos(b.angle) * step;
      b.y += Math.sin(b.angle) * step;
      b.traveled += step;
      if (b.traveled >= b.range) { b.dead = true; continue; }
      if (blockedAt(game, b.x, b.y)) {
        pushParticle(game, b.x, b.y, '#c9a227');
        b.dead = true;
        continue;
      }
      if (hitHelicopter(b.x, b.y, b.damage)) {
        pushParticle(game, b.x, b.y, '#ff6b5e');
        b.dead = true;
        continue;
      }
      if (b.fromEnemy) {
        // Enemy bullets can only hurt Rook (on foot or in a car).
        if (p && p.alive) {
          const px = p.x, py = p.y;
          if (Math.hypot(b.x - px, b.y - py) < COMBAT_BULLET_HIT_RADIUS + 4) {
            damagePlayer(game, b.damage, 'enemy');
            pushParticle(game, px, py, '#e74c3c');
            b.dead = true;
            continue;
          }
        }
        // ...or a nearby car Rook is driving (chip the car instead).
        if (p && p.car && !p.onFoot) {
          if (Math.hypot(b.x - p.car.x, b.y - p.car.y) < 26) {
            damageCar(p.car, b.damage * 0.5);
            b.dead = true;
            continue;
          }
        }
      } else {
        // Player bullets: enemies first, then cops, peds, then cars.
        let consumed = false;
        for (const e of enemiesList()) {
          if (!e || e.alive === false) continue;
          if (Math.hypot(b.x - e.x, b.y - e.y) < COMBAT_BULLET_HIT_RADIUS + 4) {
            damageEnemy(e, b.damage);
            consumed = true;
            break;
          }
        }
        if (consumed) { b.dead = true; continue; }
        for (const cop of allCops(game)) {
          if (!cop || cop.dead) continue;
          if (Math.hypot(b.x - cop.x, b.y - cop.y) < COMBAT_BULLET_HIT_RADIUS + 4) {
            cop.health = (cop.health === undefined ? COMBAT_COP_HEALTH : cop.health) - b.damage;
            addHeat(game, COMBAT_HEAT_PER_COP_HIT);
            pushParticle(game, cop.x, cop.y, '#2e7dff');
            if (cop.health <= 0) {
              cop.dead = true;
              state.copsKilled += 1;
              addHeat(game, COMBAT_HEAT_PER_COP_KILL);
            }
            consumed = true;
            break;
          }
        }
        if (consumed) { b.dead = true; continue; }
        for (const ped of allPeds(game)) {
          if (!ped || ped.dead) continue;
          if (Math.hypot(b.x - ped.x, b.y - ped.y) < COMBAT_BULLET_HIT_RADIUS) {
            ped.state = 'flee';
            ped.fleeing = true;
            ped.fleeT = 6;
            ped.fleeFromX = p ? p.x : b.x;
            ped.fleeFromY = p ? p.y : b.y;
            addHeat(game, COMBAT_HEAT_PER_PED_HIT);
            pushParticle(game, ped.x, ped.y, '#e74c3c');
            consumed = true;
            break;
          }
        }
        if (consumed) { b.dead = true; continue; }
        for (const car of game && game.cars ? game.cars : []) {
          if (!car || car.wrecked || car.player) continue;
          if (Math.hypot(b.x - car.x, b.y - car.y) < 26) {
            damageCar(car, b.damage * 0.4);
            pushParticle(game, car.x, car.y, '#f1c40f');
            consumed = true;
            break;
          }
        }
        if (consumed) { b.dead = true; continue; }
      }
    }
    state.bullets = state.bullets.filter((b) => !b.dead);
    syncBullets();
  }

  function stepEnemies(dt) {
    const p = playerObj();
    if (!p || !p.alive) return;
    for (const e of enemiesList()) {
      if (!e || e.alive === false) continue;
      const dx = p.x - e.x, dy = p.y - e.y;
      const d = Math.hypot(dx, dy);
      e.angle = Math.atan2(dy, dx);
      // Walk toward Rook until inside stopping range, then hold and shoot.
      if (d > COMBAT_ENEMY_STOP_RANGE && d < COMBAT_ENEMY_ENGAGE_RANGE) {
        const step = e.speed * dt;
        const nx = e.x + (dx / d) * step;
        const ny = e.y + (dy / d) * step;
        if (!blockedAt(game, nx, ny)) { e.x = nx; e.y = ny; }
        else if (!blockedAt(game, nx, e.y)) { e.x = nx; }
        else if (!blockedAt(game, e.x, ny)) { e.y = ny; }
      }
      e.fireT -= dt;
      if (e.fireT <= 0 && d < COMBAT_ENEMY_RANGE) {
        e.fireT = COMBAT_ENEMY_FIRE_INTERVAL * (0.85 + Math.random() * 0.5);
        fireWeapon(game, e, p.x, p.y);
      }
    }
  }

  function spawnHealthPickup(x, y) {
    if (!game) return null;
    if (!Array.isArray(game.pickups)) game.pickups = [];
    const pk = { x, y, kind: 'health', taken: false };
    game.pickups.push(pk);
    return pk;
  }

  function spawnAmmoPickup(x, y, weapon) {
    if (!game) return null;
    if (!Array.isArray(game.pickups)) game.pickups = [];
    const pk = { x, y, kind: 'ammo', weapon: weapon || 'pistol', taken: false };
    game.pickups.push(pk);
    return pk;
  }

  function stepPickups() {
    const p = playerObj();
    if (!p || !p.alive || p.onFoot === false) return;
    if (!game || !Array.isArray(game.pickups)) return;
    for (const pk of game.pickups) {
      if (!pk || pk.taken) continue;
      if (Math.hypot(pk.x - p.x, pk.y - p.y) > COMBAT_PICKUP_RADIUS) continue;
      pk.taken = true;
      if (pk.kind === 'health') {
        healPlayer(game, COMBAT_HEALTH_PICKUP_AMOUNT);
        playSound(game, 'pickup-health');
      } else if (pk.kind === 'ammo') {
        const weapon = pk.weapon || p.weapon || 'pistol';
        if (game.weapons && typeof game.weapons.addAmmo === 'function') {
          game.weapons.addAmmo(weapon, COMBAT_AMMO_PICKUP_AMOUNT);
        } else if (p.ammo) {
          p.ammo[weapon] = (p.ammo[weapon] || 0) + COMBAT_AMMO_PICKUP_AMOUNT;
        }
        playSound(game, 'pickup-ammo');
      }
    }
  }

  function update(dt) {
    const step = Math.max(0, Math.min(0.1, Number(dt) || 0.016));
    if (!game || !game.state || game.state === 'playing') {
      stepBullets(step);
      stepEnemies(step);
      stepPickups();
    }
    // Prune dead enemies from the shared list so the arena count is honest.
    if (game && Array.isArray(game.enemies) && game.enemies.length > 40) {
      game.enemies = game.enemies.filter((e) => e && e.alive !== false);
    }
    return state;
  }

  function snapshot() {
    return {
      bullets: state.bullets.length,
      shotsFired: state.shotsFired,
      hits: state.hits,
      enemiesKilled: state.enemiesKilled,
      copsKilled: state.copsKilled,
      enemiesAlive: enemiesAlive(),
    };
  }

  return {
    state,
    bullets: state.bullets,
    update,
    fireWeapon,
    spawnEnemy,
    spawnArenaEnemies,
    damageEnemy,
    nearestEnemy,
    enemiesAlive,
    spawnHealthPickup,
    spawnAmmoPickup,
    snapshot,
  };
}

export default createCombat;

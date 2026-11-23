// combat.js — Crescent Bay weapons & combat (fresh from prose spec §2, §3.2).
//
// Three weapons, one per key. Enemies use the pistol only.
//   1 pistol  — start weapon, 18 damage, medium rate, 48 starting ammo
//   2 SMG     — fast fire, 10 damage, large magazine
//   3 shotgun — slow, 5 pellets x 8 damage, spread, short range
// Q cycles to the next owned weapon. Switching is instant (no animation
// lock) and works on foot. Each weapon has its own ammo count; the HUD
// shows the current weapon name + ammo large.
//
// Weapon crates sit at fixed spots (gun store, docks, hideout) plus
// crates inside the m10/m12 shootout arenas; walking over a crate picks
// the weapon up (and gives ammo). Ammo pickups sit in shootout arenas;
// the autopilot grabs one when its current weapon's ammo is <= 6.
//
// Combat is hitscan against a target list the game supplies each shot:
// targets are { x, y, radius, hp, damage(amount, source), kind }.
// The module never assumes what an enemy is — it only reports hits and
// calls target.damage(). The helicopter is a target like any other: the
// game passes it in the target list with a large radius, and the mission
// script decides when it smokes and retreats.
//
// Context object G (only what this module reads):
//   G.player   — { x, y } (crate / ammo pickup radius is checked here)
//   G.audio    — optional { sfx(name) } for shot / pickup sounds
//   G.onShot(fromX, fromY, angle, weapon) — optional render hook (tracer)
//   G.onKill(target) — optional hook when a target's hp reaches 0
//
// Public API (returned by createCombat):
//   WEAPONS            weapon definitions
//   state()            { current, owned, ammo } snapshot for HUD / saves
//   restore(snap)      load a snapshot (save slots)
//   currentWeapon() / currentAmmo() / setWeapon(name) / cycleWeapon()
//   canFire() / cooldown()
//   fire(originX, originY, angle, targets) -> array of hit events
//   addAmmo(weapon, n) / giveWeapon(name, ammo)
//   crates() / ammoPickups()
//   addCrate(x, y, weapon, ammo) / addAmmoPickup(x, y, weapon, n)
//   seedWorldCrates()  fixed gun-store / docks / hideout crates
//   update(dt)         pickup collection + cooldown tick
//   draw(ctx, cam)     crates + ammo pickups on the ground
//   reset()            fresh start-weapon state (new game)

export const WEAPONS = {
  pistol: {
    name: 'Pistol', key: '1', damage: 18, rate: 0.28, range: 520,
    pellets: 1, spread: 0.015, startAmmo: 48, sfx: 'shot-pistol',
  },
  smg: {
    name: 'SMG', key: '2', damage: 10, rate: 0.09, range: 420,
    pellets: 1, spread: 0.05, startAmmo: 120, sfx: 'shot-smg',
  },
  shotgun: {
    name: 'Shotgun', key: '3', damage: 8, rate: 0.85, range: 260,
    pellets: 5, spread: 0.22, startAmmo: 24, sfx: 'shot-shotgun',
  },
};

const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];

// Fixed world crate spots (spec §3.2): gun store, docks, hideout.
// Coordinates are road-junction landmarks, inside the world.
const WORLD_CRATES = [
  { x: 1000, y: 600, weapon: 'smg', ammo: 120, label: 'SMG' },
  { x: 2600, y: 2600, weapon: 'shotgun', ammo: 24, label: 'Shotgun' },
  { x: 600, y: 2600, weapon: 'smg', ammo: 120, label: 'SMG' },
];

const PICKUP_RADIUS = 30;

export function createCombat(G) {
  const game = G || {};
  let owned = { pistol: true, smg: false, shotgun: false };
  let ammo = { pistol: 48, smg: 0, shotgun: 0 };
  let current = 'pistol';
  let cooldown = 0;
  let crates = [];
  let pickups = [];
  let shotsFired = 0;

  function sfx(name) {
    if (game.audio && typeof game.audio.sfx === 'function') game.audio.sfx(name);
  }

  // Ray vs circle: returns distance along the ray to the first hit, or -1.
  function rayHit(ox, oy, dx, dy, t) {
    const cx = t.x - ox;
    const cy = t.y - oy;
    const along = cx * dx + cy * dy;
    if (along < 0) return -1;
    const closestSq = cx * cx + cy * cy - along * along;
    const r = (t.radius || 16) + 2;
    if (closestSq > r * r) return -1;
    return along;
  }

  return {
    WEAPONS,

    state() {
      return {
        current,
        owned: { ...owned },
        ammo: { ...ammo },
        shotsFired,
      };
    },

    restore(snap) {
      if (!snap) return;
      if (snap.owned) owned = { pistol: !!snap.owned.pistol, smg: !!snap.owned.smg, shotgun: !!snap.owned.shotgun };
      if (snap.ammo) ammo = { pistol: snap.ammo.pistol | 0, smg: snap.ammo.smg | 0, shotgun: snap.ammo.shotgun | 0 };
      if (snap.current && owned[snap.current]) current = snap.current;
      if (typeof snap.shotsFired === 'number') shotsFired = snap.shotsFired;
    },

    reset() {
      owned = { pistol: true, smg: false, shotgun: false };
      ammo = { pistol: 48, smg: 0, shotgun: 0 };
      current = 'pistol';
      cooldown = 0;
      crates = [];
      pickups = [];
      shotsFired = 0;
      this.seedWorldCrates();
    },

    currentWeapon() { return current; },
    currentWeaponDef() { return WEAPONS[current]; },
    currentAmmo() { return ammo[current]; },
    ammoOf(w) { return ammo[w] | 0; },
    owns(w) { return !!owned[w]; },
    canFire() { return cooldown <= 0 && ammo[current] > 0; },
    cooldown() { return cooldown; },

    setWeapon(name) {
      if (WEAPONS[name] && owned[name]) {
        current = name;
        return true;
      }
      return false;
    },

    cycleWeapon() {
      const idx = WEAPON_ORDER.indexOf(current);
      for (let i = 1; i <= WEAPON_ORDER.length; i++) {
        const next = WEAPON_ORDER[(idx + i) % WEAPON_ORDER.length];
        if (owned[next]) { current = next; return current; }
      }
      return current;
    },

    giveWeapon(name, n) {
      if (!WEAPONS[name]) return false;
      owned[name] = true;
      ammo[name] = (ammo[name] | 0) + (n === undefined ? WEAPONS[name].startAmmo : n);
      return true;
    },

    addAmmo(weapon, n) {
      if (!WEAPONS[weapon]) return 0;
      ammo[weapon] = (ammo[weapon] | 0) + (n | 0);
      return ammo[weapon];
    },

    // Fire one trigger pull. Returns hit events:
    // [{ target, damage, x, y, killed, pellet }] — empty when no hit.
    // Ammo is spent even on a miss (except when the weapon is empty).
    fire(ox, oy, angle, targets) {
      const def = WEAPONS[current];
      if (cooldown > 0 || ammo[current] <= 0) return [];
      cooldown = def.rate;
      ammo[current] -= 1;
      shotsFired += 1;
      sfx(def.sfx);
      if (typeof game.onShot === 'function') game.onShot(ox, oy, angle, current);
      const hits = [];
      const list = Array.isArray(targets) ? targets : [];
      for (let p = 0; p < def.pellets; p++) {
        // Spread: centre pellet dead-on, the rest fanned out.
        const off = def.pellets === 1 ? (Math.random() - 0.5) * def.spread
          : (p - (def.pellets - 1) / 2) * (def.spread / 2) + (Math.random() - 0.5) * 0.02;
        const a = angle + off;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let best = null;
        let bestD = def.range;
        for (const t of list) {
          if (!t || typeof t.x !== 'number' || typeof t.y !== 'number') continue;
          if (typeof t.hp === 'number' && t.hp <= 0) continue;
          const d = rayHit(ox, oy, dx, dy, t);
          if (d >= 0 && d < bestD) { best = t; bestD = d; }
        }
        if (best) {
          const hx = ox + dx * bestD;
          const hy = oy + dy * bestD;
          if (typeof best.damage === 'function') best.damage(def.damage, current);
          const killed = typeof best.hp === 'number' && best.hp <= 0;
          hits.push({ target: best, damage: def.damage, x: hx, y: hy, killed, pellet: p });
          if (killed && typeof game.onKill === 'function') game.onKill(best);
        }
      }
      return hits;
    },

    crates() { return crates; },
    ammoPickups() { return pickups; },

    addCrate(x, y, weapon, n) {
      const c = { x, y, weapon, ammo: n === undefined ? WEAPONS[weapon].startAmmo : n, taken: false };
      crates.push(c);
      return c;
    },

    addAmmoPickup(x, y, weapon, n) {
      const p = { x, y, weapon: weapon || current, ammo: n || 24, taken: false };
      pickups.push(p);
      return p;
    },

    seedWorldCrates() {
      crates = WORLD_CRATES.map((c) => ({ ...c, taken: false }));
      return crates;
    },

    update(dt) {
      cooldown = Math.max(0, cooldown - dt);
      const pl = game.player;
      if (!pl || typeof pl.x !== 'number') return;
      // Weapon crates: walk over to pick up (weapon + ammo).
      for (const c of crates) {
        if (c.taken) continue;
        if (Math.hypot(c.x - pl.x, c.y - pl.y) < PICKUP_RADIUS) {
          c.taken = true;
          const had = owned[c.weapon];
          this.giveWeapon(c.weapon, c.ammo);
          if (!had) current = c.weapon; // auto-equip a brand-new weapon
          sfx('crate');
          if (typeof game.onPickup === 'function') game.onPickup('weapon', c.weapon);
        }
      }
      crates = crates.filter((c) => !c.taken);
      // Ammo pickups: same radius, only that weapon's ammo.
      for (const p of pickups) {
        if (p.taken) continue;
        if (Math.hypot(p.x - pl.x, p.y - pl.y) < PICKUP_RADIUS) {
          p.taken = true;
          this.addAmmo(p.weapon, p.ammo);
          sfx('pickup');
          if (typeof game.onPickup === 'function') game.onPickup('ammo', p.weapon);
        }
      }
      pickups = pickups.filter((p) => !p.taken);
    },

    draw(ctx, cam) {
      if (!ctx) return;
      const inView = (x, y) => !cam ||
        (x > cam.x - 40 && x < cam.x + cam.w + 40 && y > cam.y - 40 && y < cam.y + cam.h + 40);
      for (const c of crates) {
        if (!inView(c.x, c.y)) continue;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.fillStyle = 'rgba(20, 16, 60, 0.35)';
        ctx.fillRect(-13, -9, 26, 18);
        ctx.fillStyle = '#8b5a2b';
        ctx.fillRect(-14, -12, 28, 20);
        ctx.fillStyle = '#d4a017';
        ctx.fillRect(-14, -3, 28, 3);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(c.label || c.weapon.toUpperCase(), 0, -16);
        ctx.restore();
      }
      for (const p of pickups) {
        if (!inView(p.x, p.y)) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 240);
        ctx.fillStyle = `rgba(46, 204, 113, ${pulse})`;
        ctx.beginPath();
        ctx.arc(0, 0, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('AMMO', 0, 3);
        ctx.restore();
      }
    },
  };
}

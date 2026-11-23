// helicopter.js — Police helicopter (prose spec §3.1).
// Spawns at 3 wanted stars and above (and in m9 / m12 by mission script).
// It flies with no road constraint, shadows Rook from above at a fixed
// height, faster than any car. A visible spotlight circle on the ground
// follows Rook while the helicopter is overhead. While the spotlight is
// on Rook, wanted heat does NOT decay — hiding is impossible under it.
// The helicopter does not shoot. Rook can shoot it: after enough damage
// it smokes and retreats for 20 seconds, then returns if wanted is still
// 3+. When wanted drops below 3 stars, it leaves. Drawn with a shadow
// on the ground and a rotor blur.
//
// This module is self-contained: it owns the helicopter's state and
// exposes a small API the game loop calls each frame. It reads the
// player's position and wanted level through the `world` object passed
// to createHelicopter, and reports whether the spotlight is on Rook so
// the police/heat system can suppress heat decay.

export const HELI_WANTED_MIN = 3;      // stars needed for the helicopter
export const HELI_RETREAT_SECONDS = 20; // smoke + retreat duration
export const HELI_MAX_HP = 120;         // damage before it retreats
export const HELI_SPEED = 560;          // faster than any car
export const HELI_SPOT_RADIUS = 170;    // spotlight circle radius
export const HELI_FOLLOW_OFFSET = 60;   // hovers slightly ahead of Rook

// How far the helicopter stays from Rook while shadowing (it never lands
// on top of the player; it keeps a small standoff so the spotlight cone
// reads as a cone, not a dot).
export const HELI_STANDOFF = 40;

export function createHelicopter(world) {
  // world is expected to provide:
  //   world.player  -> { x, y }           (Rook's position)
  //   world.wantedStars() -> number       (current wanted stars, 0-5)
  //   world.isNight -> boolean (optional, for spotlight brightness)
  const heli = {
    active: false,      // in the sky at all
    x: 0,
    y: 0,
    hp: HELI_MAX_HP,
    state: 'away',      // 'away' | 'shadowing' | 'retreating' | 'leaving'
    retreatTimer: 0,    // seconds left in the 20s retreat
    forced: false,      // true when a mission script (m9/m12) demands it
    smoke: 0,           // 0..1 smoke intensity while retreating
    rotorAngle: 0,
    spotOn: false,      // spotlight currently on Rook
  };

  // Mission scripts call this to force the helicopter up (m9, m12)
  // or to release it back to normal wanted rules.
  function setForced(on) {
    heli.forced = !!on;
    if (on && !heli.active) spawn();
    if (!on && !wantedCallsForHeli()) heli.state = 'leaving';
  }

  function wantedCallsForHeli() {
    return world.wantedStars() >= HELI_WANTED_MIN || heli.forced;
  }

  function spawn() {
    const p = world.player;
    heli.active = true;
    heli.hp = HELI_MAX_HP;
    heli.smoke = 0;
    heli.state = 'shadowing';
    // Appear off-screen, up in the sky, then fly in toward Rook.
    heli.x = p.x + 900;
    heli.y = p.y - 700;
    heli.retreatTimer = 0;
  }

  function damage(amount) {
    if (!heli.active || heli.state === 'retreating') return false;
    heli.hp -= amount;
    if (heli.hp <= 0) {
      // Smoke and retreat for 20 seconds. It returns afterwards only
      // if wanted is still 3+ (checked in update).
      heli.state = 'retreating';
      heli.retreatTimer = HELI_RETREAT_SECONDS;
      heli.smoke = 1;
      return true;
    }
    return false;
  }

  function update(dt) {
    heli.rotorAngle += dt * 28;

    if (!heli.active) {
      if (wantedCallsForHeli()) spawn();
      heli.spotOn = false;
      return;
    }

    if (heli.state === 'retreating') {
      heli.retreatTimer -= dt;
      // Fly away from the city centre of attention while smoking.
      heli.x += HELI_SPEED * 0.9 * dt;
      heli.y -= HELI_SPEED * 0.5 * dt;
      heli.smoke = Math.max(0, heli.retreatTimer / HELI_RETREAT_SECONDS);
      heli.spotOn = false;
      if (heli.retreatTimer <= 0) {
        if (wantedCallsForHeli()) {
          heli.hp = HELI_MAX_HP;
          heli.smoke = 0;
          heli.state = 'shadowing';
        } else {
          heli.active = false;
          heli.state = 'away';
        }
      }
      return;
    }

    if (heli.state === 'leaving') {
      // Wanted dropped below 3 stars: fly off and despawn.
      heli.x += HELI_SPEED * dt;
      heli.y -= HELI_SPEED * 0.6 * dt;
      heli.spotOn = false;
      const p = world.player;
      const dx = heli.x - p.x;
      const dy = heli.y - p.y;
      if (dx * dx + dy * dy > 1400 * 1400) {
        heli.active = false;
        heli.state = 'away';
      }
      return;
    }

    // Shadowing: fly toward a point just ahead of Rook, faster than
    // any car, so it always catches up. No road constraint — it flies.
    const p = world.player;
    const targetX = p.x + HELI_STANDOFF;
    const targetY = p.y - HELI_STANDOFF;
    const dx = targetX - heli.x;
    const dy = targetY - heli.y;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, HELI_SPEED * dt);
    heli.x += (dx / dist) * step;
    heli.y += (dy / dist) * step;

    // Spotlight is on Rook whenever the helicopter is overhead.
    heli.spotOn = dist < HELI_SPOT_RADIUS + 120;

    // If wanted fell below 3 stars (and no mission forces it), leave.
    if (!wantedCallsForHeli()) heli.state = 'leaving';
  }

  // The police/heat system asks this every frame: while true, heat
  // does not decay (hiding under the spotlight is impossible).
  function blocksHeatDecay() {
    return heli.active && heli.state === 'shadowing' && heli.spotOn;
  }

  function draw(ctx, camera) {
    if (!heli.active) return;
    const sx = heli.x - camera.x;
    const sy = heli.y - camera.y;

    // Spotlight cone/circle on the ground, centred on Rook's position.
    if (heli.spotOn) {
      const p = world.player;
      const px = p.x - camera.x;
      const py = p.y - camera.y;
      const grad = ctx.createRadialGradient(px, py, 10, px, py, HELI_SPOT_RADIUS);
      grad.addColorStop(0, 'rgba(255, 250, 200, 0.35)');
      grad.addColorStop(1, 'rgba(255, 250, 200, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, HELI_SPOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      // Beam from the helicopter down to the lit circle.
      ctx.strokeStyle = 'rgba(255, 250, 200, 0.18)';
      ctx.lineWidth = 26;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    // Shadow on the ground, offset south-east (sun from the north-west).
    ctx.fillStyle = 'rgba(20, 20, 60, 0.35)';
    ctx.beginPath();
    ctx.ellipse(sx + 26, sy + 34, 34, 14, 0, 0, Math.PI * 2);
    ctx.fill();

    // Smoke trail while retreating.
    if (heli.smoke > 0) {
      ctx.fillStyle = `rgba(90, 90, 90, ${0.55 * heli.smoke})`;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(sx - 18 - i * 14, sy + 6 + i * 5, 9 + i * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Body.
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = '#1d3557';
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tail.
    ctx.fillStyle = '#1d3557';
    ctx.fillRect(-52, -4, 26, 8);
    ctx.fillStyle = '#e63946';
    ctx.fillRect(-56, -7, 8, 14);
    // Cabin window.
    ctx.fillStyle = '#a8dadc';
    ctx.beginPath();
    ctx.ellipse(16, -2, 10, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Rotor blur: two translucent blades spinning.
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.45)';
    ctx.lineWidth = 4;
    const a = heli.rotorAngle;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * -46, Math.sin(a) * -46);
    ctx.lineTo(Math.cos(a) * 46, Math.sin(a) * 46);
    ctx.moveTo(Math.cos(a + Math.PI / 2) * -46, Math.sin(a + Math.PI / 2) * -46);
    ctx.lineTo(Math.cos(a + Math.PI / 2) * 46, Math.sin(a + Math.PI / 2) * 46);
    ctx.stroke();
    ctx.restore();
  }

  return {
    heli,
    setForced,
    damage,
    update,
    draw,
    blocksHeatDecay,
    get active() { return heli.active; },
    get spotOn() { return heli.spotOn; },
  };
}

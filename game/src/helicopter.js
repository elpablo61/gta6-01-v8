// Police helicopter — Crescent Bay. Fresh from prose spec §3.1.
// A police helicopter shadows Rook from above once the wanted level reaches
// 3 stars (or a mission script forces it, m9 / m12). It never shoots. Its
// spotlight pins Rook to the ground: while the light is on Rook, wanted
// heat cannot decay, so hiding under it is impossible. Rook can shoot it
// down: enough damage makes it smoke and retreat for 20 seconds, then it
// comes back if the wanted level is still 3 stars or higher. When the
// wanted level drops below 3 stars it leaves the sky.
//
// Shared-state contract (everything is read defensively; missing fields
// fall back to safe defaults, so this module never throws on a thin game):
//   game.player  { x, y, angle, onFoot, speed } — Rook's position.
//   game.wanted  { heat, stars } — heat 0..100; stars derived from heat
//                with thresholds [0, 12, 30, 52, 74, 92] when stars is absent.
//   game.mission { id } — 'm9' / 'm12' may force the helicopter up.
//   game.helicopterForced — boolean set by a mission script to force it.
//   game.time    { now } — seconds since the run started (optional).
//   game.audio   { play(name) } — optional sound hook.
// Flags this module writes for other systems to read:
//   game.spotlightOnPlayer — true while the spotlight is on Rook.
//   game.heatDecayBlocked  — true while the spotlight blocks heat decay.
//   game.helicopterActive  — true while a helicopter is in the sky.
// The autopilot only needs one rule: never stop under the spotlight — keep
// driving toward the objective. Read isSpotlightOnPlayer() for that.

export const POLICE_HELICOPTER_RULES = {
  minStars: 3,
  cruiseSpeed: 640,
  shadowHeight: 90,
  spotlightRadius: 150,
  spotlightLockDistance: 230,
  damageToRetreat: 90,
  retreatSeconds: 20,
  spawnDistance: 500,
  leaveSpeed: 700,
  rotorBlurArms: 3,
};

export const WANTED_STAR_THRESHOLDS = [0, 12, 30, 52, 74, 92];

export function wantedStarsFromHeat(heat) {
  const h = Math.max(0, Math.min(100, Number(heat) || 0));
  let stars = 0;
  for (let i = 0; i < WANTED_STAR_THRESHOLDS.length; i++) {
    if (h >= WANTED_STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

export function wantedStars(game) {
  if (!game) return 0;
  if (game.wanted && typeof game.wanted.stars === 'number') return game.wanted.stars;
  if (game.wanted && typeof game.wanted.heat === 'number') {
    return wantedStarsFromHeat(game.wanted.heat);
  }
  if (typeof game.heat === 'number') return wantedStarsFromHeat(game.heat);
  return 0;
}

export function createPoliceHelicopter(game) {
  const rules = POLICE_HELICOPTER_RULES;
  const state = {
    active: false,
    mode: 'away',
    x: 0,
    y: 0,
    angle: 0,
    rotorAngle: 0,
    health: rules.damageToRetreat,
    retreatTimer: 0,
    smokeTimer: 0,
    spotlightOnPlayer: false,
    shotsTaken: 0,
    sorties: 0,
  };

  function playerPos() {
    const p = game && game.player;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    return { x: 1600, y: 1600, angle: 0 };
  }

  function forcedByMission() {
    if (game && game.helicopterForced) return true;
    const id = game && game.mission && game.mission.id;
    if (id === 'm9' || id === 'm12') {
      const stage = game.mission.stage;
      if (typeof stage === 'number' && stage < 0) return false;
      return true;
    }
    return false;
  }

  function shouldBeUp() {
    return wantedStars(game) >= rules.minStars || forcedByMission();
  }

  function spawn() {
    const p = playerPos();
    state.x = p.x - rules.spawnDistance;
    state.y = p.y - rules.spawnDistance;
    state.angle = Math.atan2(p.y - state.y, p.x - state.x);
    state.health = rules.damageToRetreat;
    state.mode = 'shadowing';
    state.active = true;
    state.retreatTimer = 0;
    state.smokeTimer = 0;
    state.sorties += 1;
    if (game) game.helicopterActive = true;
  }

  function leave() {
    state.mode = 'leaving';
  }

  function update(dt) {
    const step = Math.max(0, Math.min(0.1, Number(dt) || 0.016));
    state.rotorAngle += step * 22;
    const p = playerPos();
    const wanted = shouldBeUp();

    if (!state.active) {
      if (wanted) spawn();
      state.spotlightOnPlayer = false;
      if (game) {
        game.spotlightOnPlayer = false;
        game.heatDecayBlocked = false;
        game.helicopterActive = false;
      }
      return state;
    }

    if (state.mode === 'retreating') {
      state.retreatTimer -= step;
      state.smokeTimer -= step;
      const dx = state.x - p.x;
      const dy = state.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      state.x += (dx / d) * rules.cruiseSpeed * step;
      state.y += (dy / d) * rules.cruiseSpeed * step;
      state.angle = Math.atan2(dy, dx);
      state.spotlightOnPlayer = false;
      if (state.retreatTimer <= 0) {
        if (wanted) {
          state.mode = 'shadowing';
          state.health = rules.damageToRetreat;
          state.x = p.x - rules.spawnDistance;
          state.y = p.y - rules.spawnDistance;
        } else {
          state.mode = 'leaving';
        }
      }
    } else if (state.mode === 'leaving') {
      const dx = state.x - p.x;
      const dy = state.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      state.x += (dx / d) * rules.leaveSpeed * step;
      state.y += (dy / d) * rules.leaveSpeed * step;
      state.angle = Math.atan2(dy, dx);
      state.spotlightOnPlayer = false;
      if (d > 1400) {
        state.active = false;
        state.mode = 'away';
        if (game) game.helicopterActive = false;
      }
    } else {
      // Shadowing: fly straight at the point above Rook, faster than any car.
      const dx = p.x - state.x;
      const dy = p.y - state.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const speed = rules.cruiseSpeed;
      const move = Math.min(d, speed * step);
      state.x += (dx / d) * move;
      state.y += (dy / d) * move;
      state.angle = Math.atan2(dy, dx);
      state.spotlightOnPlayer = d < rules.spotlightLockDistance;
      if (!wanted) leave();
    }

    if (game) {
      game.spotlightOnPlayer = state.spotlightOnPlayer;
      game.heatDecayBlocked = state.spotlightOnPlayer;
      game.helicopterActive = state.active && state.mode !== 'leaving';
    }
    return state;
  }

  // Rook shoots the helicopter. Returns true when this hit makes it retreat.
  function applyDamage(amount) {
    if (!state.active || state.mode !== 'shadowing') return false;
    state.health -= Math.max(0, Number(amount) || 0);
    state.shotsTaken += 1;
    if (game && game.audio && typeof game.audio.play === 'function') {
      try { game.audio.play('heli-hit'); } catch (e) { /* sound is optional */ }
    }
    if (state.health <= 0) {
      state.mode = 'retreating';
      state.retreatTimer = rules.retreatSeconds;
      state.smokeTimer = rules.retreatSeconds;
      state.spotlightOnPlayer = false;
      if (game) {
        game.spotlightOnPlayer = false;
        game.heatDecayBlocked = false;
      }
      return true;
    }
    return false;
  }

  function forceSpawn() {
    if (!state.active) spawn();
    else if (state.mode !== 'shadowing') {
      state.mode = 'shadowing';
      state.health = rules.damageToRetreat;
    }
    return state;
  }

  function dismiss() {
    state.mode = 'leaving';
    state.spotlightOnPlayer = false;
    return state;
  }

  function isSpotlightOnPlayer() {
    return state.active && state.mode === 'shadowing' && state.spotlightOnPlayer;
  }

  function isSmoking() {
    return state.active && state.mode === 'retreating';
  }

  function draw(ctx, camera) {
    if (!ctx || !state.active) return;
    const camX = (camera && camera.x) || 0;
    const camY = (camera && camera.y) || 0;
    const sx = state.x - camX;
    const sy = state.y - camY;
    const h = rules.shadowHeight;
    const groundX = sx;
    const groundY = sy + h * 0.55;

    // Spotlight: a bright pool on the ground that follows Rook, plus a
    // faint cone from the helicopter down to that pool.
    if (state.mode === 'shadowing' && state.spotlightOnPlayer) {
      const p = playerPos();
      const px = p.x - camX;
      const py = p.y - camY;
      const grad = ctx.createRadialGradient(px, py, 8, px, py, rules.spotlightRadius);
      grad.addColorStop(0, 'rgba(255, 246, 200, 0.55)');
      grad.addColorStop(1, 'rgba(255, 246, 200, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, rules.spotlightRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 246, 200, 0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - 14, sy);
      ctx.lineTo(px - rules.spotlightRadius * 0.7, py);
      ctx.moveTo(sx + 14, sy);
      ctx.lineTo(px + rules.spotlightRadius * 0.7, py);
      ctx.stroke();
    }

    // Ground shadow, offset south-east (sun from the north-west).
    ctx.fillStyle = 'rgba(20, 16, 60, 0.35)';
    ctx.beginPath();
    ctx.ellipse(groundX + 18, groundY + 14, 34, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body: dark police helicopter, drawn above its shadow (fixed height).
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(state.angle);
    ctx.fillStyle = '#1d2b45';
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#274b7a';
    ctx.beginPath();
    ctx.ellipse(14, 0, 12, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#9fd8ff';
    ctx.beginPath();
    ctx.ellipse(20, 0, 6, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tail boom + tail fin.
    ctx.fillStyle = '#1d2b45';
    ctx.fillRect(-30, -3, 16, 6);
    ctx.fillRect(-46, -9, 8, 18);
    // Red-blue light bar — the only red-blue flashing thing in the city.
    const blink = Math.floor(state.rotorAngle * 2) % 2 === 0;
    ctx.fillStyle = blink ? '#ff2e2e' : '#2e7dff';
    ctx.fillRect(-4, -15, 8, 5);
    // Rotor blur: three translucent arms spinning fast.
    ctx.strokeStyle = 'rgba(220, 230, 255, 0.55)';
    ctx.lineWidth = 3;
    for (let i = 0; i < rules.rotorBlurArms; i++) {
      const a = state.rotorAngle + (i * Math.PI * 2) / rules.rotorBlurArms;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
      ctx.lineTo(Math.cos(a) * 44, Math.sin(a) * 44);
      ctx.stroke();
    }
    ctx.restore();

    // Smoke while retreating after taking enough damage.
    if (isSmoking()) {
      ctx.fillStyle = 'rgba(90, 90, 90, 0.5)';
      ctx.beginPath();
      ctx.arc(sx - 18, sy + 8, 10 + Math.random() * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx - 30, sy + 16, 13 + Math.random() * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function snapshot() {
    return {
      active: state.active,
      mode: state.mode,
      x: Math.round(state.x),
      y: Math.round(state.y),
      health: state.health,
      spotlightOnPlayer: state.spotlightOnPlayer,
      retreatTimer: Math.round(state.retreatTimer * 10) / 10,
      sorties: state.sorties,
    };
  }

  return {
    state,
    rules,
    update,
    draw,
    applyDamage,
    damage: applyDamage,
    forceSpawn,
    dismiss,
    isSpotlightOnPlayer,
    isSmoking,
    shouldBeUp,
    snapshot,
  };
}

export default createPoliceHelicopter;

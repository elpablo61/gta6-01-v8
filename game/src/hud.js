// hud.js — Crescent Bay HUD (fresh from prose spec §1, §3.2, §3.4).
//
// Everything is drawn on the canvas (the game passes ctx + viewport):
//   - wanted stars, >= 36px (top-left)
//   - objective banner, >= 28px bold over a dark scrim (lower-left)
//   - minimap, >= 180px (upper-right)
//   - thick health bar, big cash / speed / ammo, current weapon name
//   - radio station name + small animated equalizer (spec §3.4)
//   - mission notifications (toast queue, top-centre)
// Title / pause / game-over stay DOM overlays (owned by main.js), not
// this module.
//
// The HUD reads state through the context object G and through the
// modules the game hands it; every read is guarded so a missing module
// degrades to a blank field instead of a crash.
//
// Context object G (only what this module reads):
//   G.player   — { health, maxHealth, cash, onFoot, car, speed }
//   G.police   — { heat } or G.heat; stars from thresholds [0,12,30,52,74,92]
//   G.combat   — { currentWeaponDef(), currentAmmo(), currentWeapon() }
//   G.audio    — { stationName(), equalizerLevel() }
//   G.mission  — { title, objectiveText } or G.objectiveText (string)
//   G.timeOfDay— 0..24 for the clock readout
//   G.minimap  — optional { points() } returning extra dots
//                [{ x, y, color, r }] in world coords (police, heli,
//                mission markers, garage, spray shop)
//   G.notify(text) is NOT read here — notify() below is the API.
//
// Public API (returned by createHud):
//   draw(ctx, view)   view = { w, h, cam: { x, y, w, h } }
//   notify(text, ms)  queue a mission toast
//   setObjective(text)
//   clearNotifications()

export const WORLD = 3200;
export const HEAT_THRESHOLDS = [0, 12, 30, 52, 74, 92];
const MINIMAP_SIZE = 200; // >= 180px (spec §1)
const STAR_SIZE = 38; // >= 36px (spec §1)
const BANNER_FONT = 28; // >= 28px bold (spec §1)

function starsFromHeat(heat) {
  let stars = 0;
  for (let i = 0; i < HEAT_THRESHOLDS.length; i++) {
    if (heat >= HEAT_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

export function createHud(G) {
  const game = G || {};
  let objectiveText = '';
  let toasts = []; // { text, until }

  function heatNow() {
    if (game.police && typeof game.police.heat === 'number') return game.police.heat;
    if (typeof game.heat === 'number') return game.heat;
    return 0;
  }

  function drawStars(ctx, x, y, stars) {
    ctx.save();
    ctx.font = `${STAR_SIZE}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < 5; i++) {
      const sx = x + i * (STAR_SIZE + 4);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillText('★', sx + 2, y + 2);
      ctx.fillStyle = i < stars ? '#ffd700' : 'rgba(255, 255, 255, 0.25)';
      ctx.fillText('★', sx, y);
    }
    ctx.restore();
  }

  function drawHealth(ctx, x, y, w, health, maxHealth) {
    const h = 18; // thick bar (spec §1)
    const frac = Math.max(0, Math.min(1, health / (maxHealth || 100)));
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = '#222';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = frac > 0.5 ? '#2ecc71' : frac > 0.25 ? '#f39c12' : '#e74c3c';
    ctx.fillRect(x, y, w * frac, h);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.ceil(health)}`, x + w / 2, y + h / 2 + 0.5);
    ctx.restore();
  }

  function drawMinimap(ctx, x, y, size, view) {
    const scale = size / WORLD;
    ctx.save();
    // Panel.
    ctx.fillStyle = 'rgba(8, 10, 28, 0.78)';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, size, size);
    // Roads (8x8 grid, roads at 200 + i*400).
    ctx.fillStyle = 'rgba(160, 165, 190, 0.85)';
    for (let i = 0; i < 8; i++) {
      const c = 200 + i * 400;
      ctx.fillRect(x, y + c * scale - 2, size, 4);
      ctx.fillRect(x + c * scale - 2, y, 4, size);
    }
    // Water at the east edge (x > 3060).
    ctx.fillStyle = 'rgba(40, 110, 200, 0.7)';
    ctx.fillRect(x + 3060 * scale, y, size - 3060 * scale, size);
    // Extra dots: police / heli / markers / garage / spray shop.
    const extra = game.minimap && typeof game.minimap.points === 'function'
      ? game.minimap.points()
      : (game.minimapPoints || []);
    for (const pt of extra) {
      if (!pt || typeof pt.x !== 'number') continue;
      ctx.fillStyle = pt.color || '#fff';
      ctx.beginPath();
      ctx.arc(x + pt.x * scale, y + pt.y * scale, pt.r || 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Objective marker (pulsing ring).
    const obj = objectiveTarget();
    if (obj) {
      const pulse = 4 + 2 * Math.sin(Date.now() / 200);
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + obj.x * scale, y + obj.y * scale, pulse + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Player arrow (centre of the view).
    const p = game.player;
    if (p && typeof p.x === 'number') {
      const px = x + p.x * scale;
      const py = y + p.y * scale;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Viewport rectangle.
      if (view && view.cam) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          x + view.cam.x * scale, y + view.cam.y * scale,
          view.cam.w * scale, view.cam.h * scale,
        );
      }
    }
    ctx.restore();
  }

  function objectiveTarget() {
    if (game.mission && typeof game.mission.x === 'number') {
      return { x: game.mission.x, y: game.mission.y };
    }
    if (game.objective && typeof game.objective.x === 'number') {
      return { x: game.objective.x, y: game.objective.y };
    }
    return null;
  }

  function objectiveString() {
    if (objectiveText) return objectiveText;
    if (game.mission && game.mission.objectiveText) return game.mission.objectiveText;
    if (typeof game.objectiveText === 'string') return game.objectiveText;
    if (game.mission && game.mission.title) return game.mission.title;
    return 'Free roam — explore Crescent Bay';
  }

  function drawEqualizer(ctx, x, y, level) {
    // Small animated equalizer: 5 bars driven by the audio level.
    ctx.save();
    const bars = 5;
    for (let i = 0; i < bars; i++) {
      const h = 4 + (level || 0.2) * 12 * (0.5 + 0.5 * Math.sin(Date.now() / 130 + i * 1.3));
      ctx.fillStyle = '#1abc9c';
      ctx.fillRect(x + i * 6, y - h, 4, h);
    }
    ctx.restore();
  }

  return {
    setObjective(text) { objectiveText = text || ''; },
    clearNotifications() { toasts = []; },

    notify(text, ms) {
      if (!text) return;
      toasts.push({ text, until: Date.now() + (ms || 4000) });
      if (toasts.length > 3) toasts.shift();
    },

    draw(ctx, view) {
      if (!ctx || !view) return;
      const w = view.w;
      const h = view.h;
      const p = game.player || {};
      const now = Date.now();
      toasts = toasts.filter((t) => t.until > now);

      // --- Top-left: wanted stars + health + cash -----------------------
      const stars = starsFromHeat(heatNow());
      drawStars(ctx, 16, 14, stars);
      drawHealth(ctx, 16, 14 + STAR_SIZE + 10, 220, p.health === undefined ? 100 : p.health, p.maxHealth || 100);
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 4;
      ctx.fillText(`$${Math.floor(p.cash || 0).toLocaleString('en-US')}`, 16, 14 + STAR_SIZE + 10 + 24);
      ctx.restore();

      // --- Top-right: minimap -------------------------------------------
      drawMinimap(ctx, w - MINIMAP_SIZE - 16, 14, MINIMAP_SIZE, view);

      // --- Top-centre: radio station + equalizer -------------------------
      const station = game.audio && typeof game.audio.stationName === 'function'
        ? game.audio.stationName()
        : '';
      if (station) {
        ctx.save();
        ctx.font = 'bold 17px sans-serif';
        const label = `♪ ${station}`;
        const tw = ctx.measureText(label).width;
        const bx = (w - tw) / 2 - 34;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(bx - 8, 12, tw + 68, 28);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx, 27);
        const eq = game.audio && typeof game.audio.equalizerLevel === 'function'
          ? game.audio.equalizerLevel()
          : 0.3;
        drawEqualizer(ctx, bx + tw + 8, 32, eq);
        ctx.restore();
      }

      // --- Bottom-right: weapon + ammo, speed ----------------------------
      const combat = game.combat;
      const weaponName = combat && typeof combat.currentWeaponDef === 'function'
        ? combat.currentWeaponDef().name
        : '';
      const ammoCount = combat && typeof combat.currentAmmo === 'function'
        ? combat.currentAmmo()
        : 0;
      ctx.save();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 4;
      if (weaponName) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText(`${weaponName}  ${ammoCount}`, w - 18, h - 66);
      }
      if (!p.onFoot && p.car) {
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 40px sans-serif';
        const kmh = Math.round(Math.abs(p.speed || 0) * 0.9);
        ctx.fillText(`${kmh}`, w - 18, h - 18);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('km/h', w - 18, h - 58 + 40);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText('ON FOOT', w - 18, h - 18);
      }
      ctx.restore();

      // --- Lower-left: objective banner (>= 28px bold, dark scrim) -------
      const obj = objectiveString();
      ctx.save();
      ctx.font = `bold ${BANNER_FONT}px sans-serif`;
      const otw = ctx.measureText(obj).width;
      const bx = 16;
      const by = h - BANNER_FONT - 34;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(bx - 10, by - 10, otw + 20, BANNER_FONT + 20);
      ctx.fillStyle = '#ffd700';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(obj, bx, by);
      ctx.restore();

      // --- Clock (time of day) under the minimap --------------------------
      if (typeof game.timeOfDay === 'number') {
        const hh = Math.floor(game.timeOfDay) % 24;
        const mm = Math.floor((game.timeOfDay % 1) * 60);
        const label = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(w - MINIMAP_SIZE - 16, 14 + MINIMAP_SIZE + 8, 64, 24);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, w - MINIMAP_SIZE - 16 + 32, 14 + MINIMAP_SIZE + 20);
        ctx.restore();
      }

      // --- Toasts (top-centre, under the radio) ---------------------------
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 20px sans-serif';
      toasts.forEach((t, i) => {
        const ty = 52 + i * 32;
        const tw = ctx.measureText(t.text).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect((w - tw) / 2 - 12, ty - 4, tw + 24, 30);
        ctx.fillStyle = '#fff';
        ctx.fillText(t.text, w / 2, ty);
      });
      ctx.restore();
    },
  };
}

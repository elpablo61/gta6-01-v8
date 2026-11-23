// Crescent Bay — Canvas 2D renderer. Fresh from prose spec §1 + §9.2.
// The one performance rule that shapes this module: NEVER repaint the
// whole 3200x3200 city every frame — that stalls software rendering.
// The city is pre-rendered ONCE into a static offscreen layer (an
// offscreen canvas at half scale, ~1600x1600) and each frame only
// blits the visible crop of that layer, then draws the moving things:
// cars, pedestrians, police, the player, bullets, particles and the
// helicopter. The title screen runs at 60 FPS on that budget.
//
// Look: buildings are 2.5D — a roof plus a darker south side and a
// darker east side, with a blue-purple shadow falling to the
// south-east (the sun shines from the north-west, in every sprite).
// Night brings car headlights, street-lamp light pools and the police
// helicopter's spotlight cone; the helicopter itself is drawn by its
// own module (helicopter.js), called from here after the night overlay
// so its spotlight stays bright.
//
// The HUD (stars, health, minimap, objective banner, cash, speed,
// ammo, radio station) lives in hud.js, not here. This module draws
// the world, the entities and the light — nothing else.

import {
  WORLD_SIZE,
  ROAD_WIDTH,
  ROAD_LINES,
  WATER_EDGE_X,
  BEACH_EDGE_X,
} from './world.js';

export const RENDER_SETTINGS = {
  staticScale: 0.5,
  staticSize: 1600,
  worldSize: WORLD_SIZE,
  // Sun from the north-west: shadows fall to the south-east.
  shadowOffsetX: 0.45,
  shadowOffsetY: 0.45,
  shadowColor: 'rgba(72, 58, 140, 0.32)',
  sideDarkenSouth: 'rgba(0, 0, 0, 0.28)',
  sideDarkenEast: 'rgba(0, 0, 0, 0.18)',
  nightOverlay: 'rgba(8, 14, 44, 0.52)',
  duskOverlay: 'rgba(24, 16, 54, 0.22)',
  viewMargin: 120,
};

// Read an entity list defensively: the game object may carry a list
// under any of several names, or not at all. Never throw on a thin game.
function pickList(game, names) {
  if (!game) return [];
  for (const name of names) {
    const v = game[name];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function pickObject(game, names) {
  if (!game) return null;
  for (const name of names) {
    const v = game[name];
    if (v && typeof v === 'object') return v;
  }
  return null;
}

// How dark the scene is, 0 (bright day) to 1 (deep night). The game may
// supply game.nightFactor (0..1), game.timeOfDay / game.time.dayFraction
// (0..1 around the clock), or a plain game.isNight boolean.
export function darknessForGame(game) {
  if (!game) return 0;
  if (typeof game.nightFactor === 'number') {
    return Math.max(0, Math.min(1, game.nightFactor));
  }
  if (game.isNight === true) return 0.85;
  let f = null;
  if (typeof game.timeOfDay === 'number') f = game.timeOfDay;
  else if (game.time && typeof game.time.dayFraction === 'number') f = game.time.dayFraction;
  else if (game.time && typeof game.time.hour === 'number') f = (game.time.hour % 24) / 24;
  if (f === null || Number.isNaN(f)) return 0;
  // Day is 0.25..0.75 of the clock; night is the rest, with soft edges.
  if (f >= 0.3 && f <= 0.7) return 0;
  if (f >= 0.22 && f < 0.3) return (0.3 - f) / 0.08 * 0.4;
  if (f > 0.7 && f <= 0.78) return (f - 0.7) / 0.08 * 0.4;
  return 0.85;
}

export function createRenderer(canvas, game, worldObj) {
  const ctx = canvas ? canvas.getContext('2d') : null;
  const world = worldObj || (game && game.world) || null;

  const camera = {
    x: 0,
    y: 0,
    zoom: 1,
    width: 1280,
    height: 800,
  };

  let staticLayer = null;
  let staticDirty = true;
  let lastPlayerX = 0;
  let lastPlayerY = 0;

  function makeOffscreen(w, h) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function shadeColor(hex, factor) {
    // Darken a #rrggbb colour by factor (0..1), keeping hue.
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
    const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
    const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ---- Static layer: the whole city, drawn once -------------------
  function drawStaticInto(sctx, scale) {
    const S = scale;
    const W = WORLD_SIZE * S;
    // Ground: warm neutral city base.
    sctx.fillStyle = '#a89a7d';
    sctx.fillRect(0, 0, W, WORLD_SIZE * S);

    // Beach sand, then water, on the east edge.
    sctx.fillStyle = '#e0c996';
    sctx.fillRect(BEACH_EDGE_X * S, 0, (WATER_EDGE_X - BEACH_EDGE_X) * S, WORLD_SIZE * S);
    sctx.fillStyle = '#3fa7d6';
    sctx.fillRect(WATER_EDGE_X * S, 0, (WORLD_SIZE - WATER_EDGE_X) * S, WORLD_SIZE * S);
    sctx.strokeStyle = 'rgba(255,255,255,0.5)';
    sctx.lineWidth = 2;
    for (let y = 60; y < WORLD_SIZE; y += 180) {
      sctx.beginPath();
      sctx.moveTo((WATER_EDGE_X + 8) * S, y * S);
      sctx.lineTo((WATER_EDGE_X + 60) * S, y * S);
      sctx.stroke();
    }

    // Parks (green blocks with a few trees).
    const parks = (world && world.parks) || [];
    for (const park of parks) {
      sctx.fillStyle = '#7fae62';
      sctx.fillRect(park.x * S, park.y * S, park.w * S, park.h * S);
      sctx.fillStyle = '#6a9a52';
      sctx.fillRect(park.x * S, park.y * S, park.w * S, 8 * S);
    }
    const trees = (world && world.trees) || [];
    for (const t of trees) {
      sctx.fillStyle = 'rgba(46, 90, 40, 0.5)';
      sctx.beginPath();
      sctx.arc((t.x + 4) * S, (t.y + 5) * S, t.r * S, 0, Math.PI * 2);
      sctx.fill();
      sctx.fillStyle = '#4e8a3e';
      sctx.beginPath();
      sctx.arc(t.x * S, t.y * S, t.r * S, 0, Math.PI * 2);
      sctx.fill();
      sctx.fillStyle = '#6fae56';
      sctx.beginPath();
      sctx.arc((t.x - 3) * S, (t.y - 3) * S, t.r * 0.55 * S, 0, Math.PI * 2);
      sctx.fill();
    }

    // Roads: warm grey asphalt, pale sidewalks, dashed centre lines.
    for (const line of ROAD_LINES) {
      sctx.fillStyle = '#b5ab98';
      sctx.fillRect(0, (line - ROAD_WIDTH / 2 - 16) * S, W, (ROAD_WIDTH + 32) * S);
      sctx.fillRect((line - ROAD_WIDTH / 2 - 16) * S, 0, (ROAD_WIDTH + 32) * S, WORLD_SIZE * S);
      sctx.fillStyle = '#6f6a63';
      sctx.fillRect(0, (line - ROAD_WIDTH / 2) * S, W, ROAD_WIDTH * S);
      sctx.fillRect((line - ROAD_WIDTH / 2) * S, 0, ROAD_WIDTH * S, WORLD_SIZE * S);
    }
    sctx.strokeStyle = 'rgba(240, 230, 200, 0.75)';
    sctx.lineWidth = Math.max(1, 3 * S);
    sctx.setLineDash([18 * S, 22 * S]);
    for (const line of ROAD_LINES) {
      sctx.beginPath();
      sctx.moveTo(0, line * S);
      sctx.lineTo(W, line * S);
      sctx.stroke();
      sctx.beginPath();
      sctx.moveTo(line * S, 0);
      sctx.lineTo(line * S, WORLD_SIZE * S);
      sctx.stroke();
    }
    sctx.setLineDash([]);

    // Pier + moored boats on the east edge.
    const pier = world && world.pier;
    if (pier) {
      sctx.fillStyle = '#8a6a45';
      sctx.fillRect(pier.x * S, pier.y * S, pier.w * S, pier.h * S);
      sctx.fillStyle = '#a8845a';
      for (let x = pier.x; x < pier.x + pier.w; x += 24) {
        sctx.fillRect(x * S, pier.y * S, 2 * S, pier.h * S);
      }
    }
    const boats = (world && world.boats) || [];
    for (const b of boats) {
      sctx.save();
      sctx.translate(b.x * S, b.y * S);
      sctx.rotate(b.angle || 0);
      sctx.fillStyle = '#f2f2f2';
      sctx.fillRect(-16 * S, -6 * S, 32 * S, 12 * S);
      sctx.fillStyle = '#c0392b';
      sctx.fillRect(-16 * S, -6 * S, 8 * S, 12 * S);
      sctx.restore();
    }

    // Buildings, 2.5D: blue-purple shadow to the south-east, darker
    // south and east sides, roof on top, windows on towers.
    const buildings = (world && world.buildings) || [];
    for (const b of buildings) {
      const h = (b.height || 16) * S;
      const ox = h * RENDER_SETTINGS.shadowOffsetX;
      const oy = h * RENDER_SETTINGS.shadowOffsetY;
      sctx.fillStyle = RENDER_SETTINGS.shadowColor;
      sctx.fillRect((b.x + ox) * S, (b.y + oy) * S, b.w * S, b.h * S);
      // South side (darker) and east side (dark).
      sctx.fillStyle = shadeColor(b.color || '#9c5a44', 0.62);
      sctx.fillRect(b.x * S, (b.y + b.h) * S, b.w * S, h * 0.55);
      sctx.fillStyle = shadeColor(b.color || '#9c5a44', 0.72);
      sctx.fillRect((b.x + b.w) * S, b.y * S, h * 0.55, b.h * S);
      // Roof.
      sctx.fillStyle = b.color || '#9c5a44';
      sctx.fillRect(b.x * S, b.y * S, b.w * S, b.h * S);
      sctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      sctx.fillRect(b.x * S, b.y * S, b.w * S, 6 * S);
      // Windows: a grid on towers, a few on houses.
      if ((b.kind === 'tower' || (b.height || 0) > 30) && b.w > 60 && b.h > 60) {
        sctx.fillStyle = 'rgba(190, 220, 245, 0.85)';
        const cols = Math.max(2, Math.floor(b.w / 34));
        const rows = Math.max(2, Math.floor(b.h / 34));
        for (let cx = 0; cx < cols; cx += 1) {
          for (let cy = 0; cy < rows; cy += 1) {
            sctx.fillRect(
              (b.x + 10 + cx * (b.w - 20) / cols) * S,
              (b.y + 10 + cy * (b.h - 20) / rows) * S,
              10 * S,
              12 * S,
            );
          }
        }
      } else {
        sctx.fillStyle = 'rgba(255, 240, 200, 0.7)';
        sctx.fillRect((b.x + b.w * 0.3) * S, (b.y + b.h * 0.35) * S, 8 * S, 10 * S);
        sctx.fillRect((b.x + b.w * 0.6) * S, (b.y + b.h * 0.35) * S, 8 * S, 10 * S);
      }
    }

    // Landmark labels, small and quiet — the mission diamond is drawn
    // per frame, on top, so it can pulse.
    const marks = (world && world.landmarks) || {};
    sctx.font = 'bold ' + Math.max(11, 13 * S * 2) + 'px sans-serif';
    sctx.textAlign = 'center';
    sctx.fillStyle = 'rgba(40, 32, 20, 0.65)';
    for (const key of Object.keys(marks)) {
      const m = marks[key];
      if (typeof m.x !== 'number') continue;
      sctx.fillText((m.label || key).toUpperCase(), m.x * S, (m.y - 12) * S);
    }
  }

  function buildStaticLayer() {
    const size = RENDER_SETTINGS.staticSize;
    const layer = makeOffscreen(size, size);
    if (!layer) {
      staticLayer = null;
      return null;
    }
    const sctx = layer.getContext('2d');
    drawStaticInto(sctx, RENDER_SETTINGS.staticScale);
    staticLayer = layer;
    staticDirty = false;
    return layer;
  }

  function ensureStaticLayer() {
    if (staticDirty || !staticLayer) buildStaticLayer();
    return staticLayer;
  }

  // ---- Camera ------------------------------------------------------
  function updateCamera(dt) {
    const p = game && game.player;
    if (p && typeof p.x === 'number') {
      lastPlayerX = p.x;
      lastPlayerY = p.y;
    }
    const tx = lastPlayerX - camera.width / 2;
    const ty = lastPlayerY - camera.height / 2;
    const k = dt > 0 ? Math.min(1, dt * 6) : 1;
    camera.x += (tx - camera.x) * k;
    camera.y += (ty - camera.y) * k;
    const maxX = Math.max(0, WORLD_SIZE - camera.width);
    const maxY = Math.max(0, WORLD_SIZE - camera.height);
    camera.x = Math.max(0, Math.min(maxX, camera.x));
    camera.y = Math.max(0, Math.min(maxY, camera.y));
  }

  function screenToWorld(sx, sy) {
    return { x: sx + camera.x, y: sy + camera.y };
  }

  function worldToScreen(wx, wy) {
    return { x: wx - camera.x, y: wy - camera.y };
  }

  function inView(x, y, margin) {
    const m = margin === undefined ? RENDER_SETTINGS.viewMargin : margin;
    return (
      x > camera.x - m && x < camera.x + camera.width + m &&
      y > camera.y - m && y < camera.y + camera.height + m
    );
  }

  // ---- Dynamic entities --------------------------------------------
  function drawSkids() {
    const skids = pickList(game, ['skids', 'skidMarks']);
    for (const s of skids) {
      if (!s || !inView(s.x, s.y, 40)) continue;
      const p = worldToScreen(s.x, s.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(s.angle || 0);
      ctx.strokeStyle = 'rgba(30, 26, 22, 0.55)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-14, -7);
      ctx.lineTo(14, -7);
      ctx.moveTo(-14, 7);
      ctx.lineTo(14, 7);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawCarShape(car, isPlayer) {
    const len = car.type === 'truck' ? 52 : car.type === 'sports' ? 44 : 46;
    const wid = car.type === 'truck' ? 24 : 20;
    ctx.save();
    ctx.translate(car.x - camera.x, car.y - camera.y);
    ctx.rotate(car.angle || 0);
    // Player ring: a thin white / yellow ring on the ground under the
    // player's car, so Rook is findable in the busiest frame.
    if (isPlayer) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, len * 0.72, wid * 0.85, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(241, 196, 15, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, len * 0.8, wid * 0.95, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(20, 16, 60, 0.3)';
    ctx.fillRect(-len / 2 + 4, -wid / 2 + 5, len, wid);
    ctx.fillStyle = car.color || '#c0392b';
    ctx.fillRect(-len / 2, -wid / 2, len, wid);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-len / 2, -wid / 2, len, 4);
    // Windshield + roof.
    ctx.fillStyle = '#1d2b45';
    ctx.fillRect(-4, -wid / 2 + 3, 12, wid - 6);
    ctx.fillStyle = shadeColor(car.color || '#c0392b', 0.75);
    ctx.fillRect(-len / 2 + 6, -wid / 2 + 3, 10, wid - 6);
    // Headlight dots (the cones are drawn in the night pass).
    ctx.fillStyle = '#fff6c8';
    ctx.fillRect(len / 2 - 3, -wid / 2 + 2, 3, 4);
    ctx.fillRect(len / 2 - 3, wid / 2 - 6, 3, 4);
    // Police light bar: the ONLY red-blue flashing thing in the city.
    if (car.type === 'police' || car.isPolice) {
      const blink = Math.floor((game && game.time ? game.time.now : 0) * 6) % 2 === 0;
      ctx.fillStyle = blink ? '#ff2e2e' : '#2e7dff';
      ctx.fillRect(-6, -wid / 2 - 3, 12, 5);
    }
    // Damage smoke puff, drawn above the car.
    if ((car.health !== undefined && car.health < 35) || car.smoking) {
      ctx.fillStyle = 'rgba(90, 90, 90, 0.55)';
      ctx.beginPath();
      ctx.arc(-len / 4, -wid / 4, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCars() {
    const cars = pickList(game, ['cars', 'vehicles']);
    const traffic = pickObject(game, ['traffic']);
    const trafficCars = traffic && Array.isArray(traffic.cars) ? traffic.cars : [];
    const police = pickObject(game, ['police']);
    const policeCars = police && Array.isArray(police.cars) ? police.cars : [];
    const playerCar = game && game.player && game.player.car;
    const seen = new Set();
    const all = cars.concat(trafficCars, policeCars);
    if (playerCar) all.push(playerCar);
    for (const car of all) {
      if (!car || typeof car.x !== 'number' || seen.has(car)) continue;
      seen.add(car);
      if (!inView(car.x, car.y, 80)) continue;
      drawCarShape(car, car === playerCar);
    }
  }

  function drawPedestrians() {
    const peds = pickList(game, ['pedestrians', 'peds']);
    for (const ped of peds) {
      if (!ped || typeof ped.x !== 'number' || !inView(ped.x, ped.y, 40)) continue;
      const p = worldToScreen(ped.x, ped.y);
      ctx.fillStyle = 'rgba(20, 16, 60, 0.3)';
      ctx.beginPath();
      ctx.ellipse(p.x + 2, p.y + 3, 7, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ped.color || '#e67e22';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f2c89b';
      ctx.beginPath();
      ctx.arc(p.x, p.y - 2, 4, 0, Math.PI * 2);
      ctx.fill();
      if (ped.fleeing) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x - 8, p.y - 10);
        ctx.lineTo(p.x + 8, p.y - 10);
        ctx.stroke();
      }
    }
  }

  function drawEnemies() {
    const enemies = pickList(game, ['enemies']);
    const mission = pickObject(game, ['mission']);
    const missionEnemies = mission && Array.isArray(mission.enemies) ? mission.enemies : [];
    for (const e of enemies.concat(missionEnemies)) {
      if (!e || typeof e.x !== 'number' || e.alive === false) continue;
      if (e.health !== undefined && e.health <= 0) continue;
      if (!inView(e.x, e.y, 40)) continue;
      const p = worldToScreen(e.x, e.y);
      ctx.fillStyle = '#8e241f';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      // Health tick above the enemy.
      if (typeof e.health === 'number' && typeof e.maxHealth === 'number') {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(p.x - 12, p.y - 20, 24, 4);
        ctx.fillStyle = '#e74c3c';
        ctx.fillRect(p.x - 12, p.y - 20, 24 * Math.max(0, e.health / e.maxHealth), 4);
      }
    }
  }

  function drawPickups() {
    const pickups = pickList(game, ['pickups', 'healthPickups']);
    for (const pk of pickups) {
      if (!pk || typeof pk.x !== 'number' || pk.taken) continue;
      if (!inView(pk.x, pk.y, 40)) continue;
      const p = worldToScreen(pk.x, pk.y);
      const isAmmo = pk.kind === 'ammo';
      ctx.fillStyle = isAmmo ? '#2e7d32' : '#c0392b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(isAmmo ? 'A' : '+', p.x, p.y + 4);
    }
  }

  function drawBullets() {
    const bullets = pickList(game, ['bullets']);
    const combat = pickObject(game, ['combat']);
    const combatBullets = combat && Array.isArray(combat.bullets) ? combat.bullets : [];
    for (const b of bullets.concat(combatBullets)) {
      if (!b || typeof b.x !== 'number' || !inView(b.x, b.y, 20)) continue;
      const p = worldToScreen(b.x, b.y);
      ctx.strokeStyle = b.fromEnemy ? '#ff6b5e' : '#fff3a0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - Math.cos(b.angle || 0) * 14, p.y - Math.sin(b.angle || 0) * 14);
      ctx.stroke();
    }
  }

  function drawParticles() {
    const parts = pickList(game, ['particles']);
    for (const pt of parts) {
      if (!pt || typeof pt.x !== 'number' || !inView(pt.x, pt.y, 20)) continue;
      const p = worldToScreen(pt.x, pt.y);
      const life = pt.maxLife ? Math.max(0, pt.life / pt.maxLife) : 1;
      ctx.globalAlpha = life;
      ctx.fillStyle = pt.color || '#f1c40f';
      ctx.beginPath();
      ctx.arc(p.x, p.y, (pt.size || 3) * life + 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawMuzzleFlash() {
    const flash = game && game.muzzleFlash;
    if (!flash || typeof flash.x !== 'number') return;
    const now = game.time ? game.time.now : 0;
    if (flash.until !== undefined && now > flash.until) return;
    if (!inView(flash.x, flash.y, 30)) return;
    const p = worldToScreen(flash.x, flash.y);
    ctx.fillStyle = 'rgba(255, 240, 150, 0.95)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 180, 60, 0.8)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayerOnFoot() {
    const p = game && game.player;
    if (!p || typeof p.x !== 'number' || p.onFoot === false) return;
    if (!inView(p.x, p.y, 40)) return;
    const sp = worldToScreen(p.x, p.y);
    // White outline so Rook is findable in the busiest frame.
    ctx.fillStyle = 'rgba(20, 16, 60, 0.3)';
    ctx.beginPath();
    ctx.ellipse(sp.x + 2, sp.y + 3, 9, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#2471a3';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2c89b';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y - 1, 5, 0, Math.PI * 2);
    ctx.fill();
    // Aim tick: a short line toward the mouse.
    const a = p.angle || 0;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sp.x + Math.cos(a) * 10, sp.y + Math.sin(a) * 10);
    ctx.lineTo(sp.x + Math.cos(a) * 22, sp.y + Math.sin(a) * 22);
    ctx.stroke();
    // Direction arrow when moving.
    if (p.moving) {
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath();
      ctx.moveTo(sp.x + Math.cos(a) * 26, sp.y + Math.sin(a) * 26);
      ctx.lineTo(sp.x + Math.cos(a + 2.6) * 18, sp.y + Math.sin(a + 2.6) * 18);
      ctx.lineTo(sp.x + Math.cos(a - 2.6) * 18, sp.y + Math.sin(a - 2.6) * 18);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawMissionMarker() {
    const target = (game && game.missionTarget) || (game && game.objectiveTarget) ||
      (game && game.mission && game.mission.target) || null;
    if (!target || typeof target.x !== 'number') return;
    if (!inView(target.x, target.y, 60)) return;
    const p = worldToScreen(target.x, target.y);
    const now = game && game.time ? game.time.now : 0;
    const pulse = 1 + 0.15 * Math.sin(now * 4);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#f1c40f';
    ctx.strokeStyle = '#7a5a00';
    ctx.lineWidth = 3;
    const s = 13 * pulse;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.restore();
  }

  function drawRoadblocks() {
    const police = pickObject(game, ['police']);
    const blocks = police && Array.isArray(police.roadblocks) ? police.roadblocks : [];
    for (const rb of blocks) {
      if (!rb || typeof rb.x !== 'number' || !inView(rb.x, rb.y, 80)) continue;
      const p = worldToScreen(rb.x, rb.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(rb.angle || 0);
      ctx.fillStyle = '#2e4053';
      ctx.fillRect(-34, -8, 68, 16);
      ctx.fillStyle = '#f1c40f';
      for (let i = -30; i < 30; i += 12) {
        ctx.fillRect(i, -8, 6, 16);
      }
      ctx.restore();
    }
  }

  function drawCopsOnFoot() {
    const police = pickObject(game, ['police']);
    const cops = police && Array.isArray(police.cops) ? police.cops : pickList(game, ['cops']);
    for (const cop of cops) {
      if (!cop || typeof cop.x !== 'number' || !inView(cop.x, cop.y, 40)) continue;
      const p = worldToScreen(cop.x, cop.y);
      ctx.fillStyle = '#1d2b45';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9fd8ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y - 1, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Night: dark overlay, then light pools -----------------------
  function drawNight(darkness) {
    if (darkness <= 0.02) return;
    ctx.fillStyle = 'rgba(8, 14, 44, ' + (darkness * 0.52).toFixed(3) + ')';
    ctx.fillRect(0, 0, camera.width, camera.height);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Street-lamp pools.
    const lamps = (world && world.lamps) || [];
    for (const lamp of lamps) {
      if (!inView(lamp.x, lamp.y, 200)) continue;
      const p = worldToScreen(lamp.x, lamp.y);
      const grad = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 110);
      grad.addColorStop(0, 'rgba(255, 214, 120, 0.30)');
      grad.addColorStop(1, 'rgba(255, 214, 120, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 110, 0, Math.PI * 2);
      ctx.fill();
    }
    // Headlights: a light pool ahead of every car in view.
    const cars = pickList(game, ['cars', 'vehicles']);
    const playerCar = game && game.player && game.player.car;
    const all = playerCar ? cars.concat([playerCar]) : cars;
    const seen = new Set();
    for (const car of all) {
      if (!car || typeof car.x !== 'number' || seen.has(car)) continue;
      seen.add(car);
      if (!inView(car.x, car.y, 200)) continue;
      const a = car.angle || 0;
      const fx = car.x + Math.cos(a) * 70;
      const fy = car.y + Math.sin(a) * 70;
      const fp = worldToScreen(fx, fy);
      const grad = ctx.createRadialGradient(fp.x, fp.y, 4, fp.x, fp.y, 120);
      grad.addColorStop(0, 'rgba(255, 246, 200, 0.34)');
      grad.addColorStop(1, 'rgba(255, 246, 200, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(fp.x, fp.y, 120, 0, Math.PI * 2);
      ctx.fill();
      // Headlight cone from the car's nose.
      const nose = worldToScreen(car.x + Math.cos(a) * 22, car.y + Math.sin(a) * 22);
      const cone = ctx.createRadialGradient(nose.x, nose.y, 2, fp.x, fp.y, 130);
      cone.addColorStop(0, 'rgba(255, 246, 200, 0.22)');
      cone.addColorStop(1, 'rgba(255, 246, 200, 0)');
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(nose.x, nose.y);
      ctx.lineTo(fp.x + Math.cos(a + 0.45) * 110, fp.y + Math.sin(a + 0.45) * 110);
      ctx.lineTo(fp.x + Math.cos(a - 0.45) * 110, fp.y + Math.sin(a - 0.45) * 110);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- Main render ---------------------------------------------------
  function render(dt) {
    if (!ctx || !canvas) return false;
    const step = typeof dt === 'number' ? dt : 0.016;
    updateCamera(step);
    const vw = camera.width;
    const vh = camera.height;

    ctx.clearRect(0, 0, vw, vh);
    const layer = ensureStaticLayer();
    if (layer) {
      // Blit only the visible crop of the static layer (half scale).
      const s = RENDER_SETTINGS.staticScale;
      ctx.drawImage(
        layer,
        camera.x * s, camera.y * s, vw * s, vh * s,
        0, 0, vw, vh,
      );
    } else {
      ctx.fillStyle = '#a89a7d';
      ctx.fillRect(0, 0, vw, vh);
    }

    drawSkids();
    drawMissionMarker();
    // Sub-system draws (garage zone ring, weapon crates) — each module
    // guards its own missing state, so a thin game still renders.
    try {
      if (game && game.garage && typeof game.garage.draw === 'function') {
        game.garage.draw(ctx, camera);
      }
    } catch (e) { /* a subsystem draw never breaks the frame */ }
    try {
      if (game && game.weapons && typeof game.weapons.draw === 'function') {
        game.weapons.draw(ctx, camera);
      }
    } catch (e) { /* ignore */ }
    drawRoadblocks();
    drawCars();
    drawPedestrians();
    drawCopsOnFoot();
    drawEnemies();
    drawPickups();
    drawBullets();
    drawParticles();
    drawMuzzleFlash();
    drawPlayerOnFoot();

    const darkness = darknessForGame(game);
    drawNight(darkness);

    // Helicopter last: its spotlight must stay bright over the night
    // overlay, and its body flies above everything on the ground.
    try {
      if (game && game.helicopter && typeof game.helicopter.draw === 'function') {
        game.helicopter.draw(ctx, camera);
      }
    } catch (e) { /* ignore */ }

    // Dusk tint for the golden-hour edges of the day.
    if (darkness > 0.02 && darkness < 0.5) {
      ctx.fillStyle = RENDER_SETTINGS.duskOverlay;
      ctx.fillRect(0, 0, vw, vh);
    }
    return true;
  }

  function resize(width, height, dpr) {
    const w = width || (canvas && canvas.clientWidth) || 1280;
    const h = height || (canvas && canvas.clientHeight) || 800;
    const ratio = Math.max(1, Math.min(2, dpr || 1));
    if (canvas) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    camera.width = w;
    camera.height = h;
    if (ctx && canvas) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width: w, height: h, dpr: ratio };
  }

  function snapToPlayer() {
    const p = game && game.player;
    if (p && typeof p.x === 'number') {
      lastPlayerX = p.x;
      lastPlayerY = p.y;
      camera.x = Math.max(0, Math.min(Math.max(0, WORLD_SIZE - camera.width), p.x - camera.width / 2));
      camera.y = Math.max(0, Math.min(Math.max(0, WORLD_SIZE - camera.height), p.y - camera.height / 2));
    }
  }

  function snapshot() {
    return {
      camera: { x: Math.round(camera.x), y: Math.round(camera.y), width: camera.width, height: camera.height },
      staticLayerReady: !!staticLayer,
      darkness: darknessForGame(game),
    };
  }

  return {
    camera,
    render,
    resize,
    buildStaticLayer,
    ensureStaticLayer,
    screenToWorld,
    worldToScreen,
    inView,
    snapToPlayer,
    darknessForGame: () => darknessForGame(game),
    snapshot,
  };
}

export default createRenderer;

// pedestrians.js — Crescent Bay pedestrians (fresh from prose spec §1, §3.6).
//
// People walk the sidewalks (offset from the road centreline), cross at
// junctions now and then, and flee when scared — a gunshot, a speeding
// car, or police trouble nearby. Variety: different colours and walking
// speeds, some walking in pairs (spec §3.6).
//
// Context object G (only what this module reads):
//   G.rng     — function () => [0,1); local mulberry32 fallback
//   G.player  — { x, y } for despawn distance
//   G.scares  — optional array the game may push { x, y, radius } into;
//               scare(x, y, radius) is the direct call
//
// Public API (returned by createPedestrians):
//   update(dt)
//   draw(ctx, cam)
//   list()                 live pedestrians
//   scare(x, y, radius)    make nearby pedestrians flee
//   spawnFleeing(x, y, color)  a carjacked driver running away
//   count()
//   clear()

export const WORLD = 3200;
export const ROAD_STEP = 400;
export const ROAD_FIRST = 200;
export const ROAD_COUNT = 8;
export const SIDEWALK = 48; // sidewalk offset from road centreline

const SHIRTS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c',
  '#e67e22', '#ecf0f1', '#fd79a8', '#00cec9', '#fdcb6e', '#6c5ce7',
];
const PANTS = ['#2c3e50', '#34495e', '#7f8c8d', '#5d4037', '#1a252f'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roadCoord(i) { return ROAD_FIRST + i * ROAD_STEP; }
function nearestRoadIndex(v) {
  return Math.max(0, Math.min(ROAD_COUNT - 1, Math.round((v - ROAD_FIRST) / ROAD_STEP)));
}

export function createPedestrians(G) {
  const game = G || {};
  const rng = typeof game.rng === 'function' ? game.rng : mulberry32(20261119);
  let people = [];
  let nextId = 1;

  function makePerson(x, y, opts) {
    const o = opts || {};
    const p = {
      id: nextId++,
      x, y,
      // Walking axis: 'h' along a horizontal road, 'v' along a vertical one.
      axis: o.axis || (rng() < 0.5 ? 'h' : 'v'),
      dir: o.dir || (rng() < 0.5 ? 1 : -1),
      speed: o.speed || (26 + rng() * 30),
      baseSpeed: 0,
      shirt: o.shirt || SHIRTS[Math.floor(rng() * SHIRTS.length)],
      pants: PANTS[Math.floor(rng() * PANTS.length)],
      state: 'walk', // walk | flee | cross
      fleeX: 0, fleeY: 0,
      fleeTime: 0,
      pairId: o.pairId || 0,
      pause: 0,
      roadIndex: 0,
      side: rng() < 0.5 ? -1 : 1,
    };
    p.baseSpeed = p.speed;
    // Snap onto the sidewalk of the nearest road on the walking axis.
    if (p.axis === 'h') {
      p.roadIndex = nearestRoadIndex(y);
      p.y = roadCoord(p.roadIndex) + p.side * SIDEWALK;
    } else {
      p.roadIndex = nearestRoadIndex(x);
      p.x = roadCoord(p.roadIndex) + p.side * SIDEWALK;
    }
    return p;
  }

  function spawnPerson(nearX, nearY) {
    const j = {
      col: Math.floor(rng() * ROAD_COUNT),
      row: Math.floor(rng() * ROAD_COUNT),
    };
    let x = roadCoord(j.col) + (rng() - 0.5) * 300;
    let y = roadCoord(j.row) + (rng() - 0.5) * 300;
    if (typeof nearX === 'number') {
      x = nearX + (rng() - 0.5) * 500;
      y = nearY + (rng() - 0.5) * 500;
    }
    x = Math.max(30, Math.min(WORLD - 30, x));
    y = Math.max(30, Math.min(WORLD - 30, y));
    const p = makePerson(x, y);
    // A pair partner walks beside them, same speed and direction.
    if (rng() < 0.3) {
      const partner = makePerson(x + 14 * p.dir, y + 10, {
        axis: p.axis, dir: p.dir, speed: p.speed, pairId: p.id,
        shirt: SHIRTS[Math.floor(rng() * SHIRTS.length)],
      });
      partner.roadIndex = p.roadIndex;
      partner.side = p.side;
      p.pairId = partner.id;
      people.push(partner);
    }
    people.push(p);
    return p;
  }

  function updatePerson(p, dt) {
    if (p.pause > 0) { p.pause -= dt; return; }

    if (p.state === 'flee') {
      p.fleeTime -= dt;
      const dx = p.x - p.fleeX;
      const dy = p.y - p.fleeY;
      const d = Math.hypot(dx, dy) || 1;
      const runSpeed = p.baseSpeed * 3.2;
      p.x += (dx / d) * runSpeed * dt;
      p.y += (dy / d) * runSpeed * dt;
      p.x = Math.max(20, Math.min(WORLD - 20, p.x));
      p.y = Math.max(20, Math.min(WORLD - 20, p.y));
      if (p.fleeTime <= 0) {
        p.state = 'walk';
        p.speed = p.baseSpeed;
        // Settle back onto the nearest sidewalk.
        if (Math.abs(p.x - roadCoord(nearestRoadIndex(p.x))) <
            Math.abs(p.y - roadCoord(nearestRoadIndex(p.y)))) {
          p.axis = 'v';
          p.roadIndex = nearestRoadIndex(p.x);
          p.x = roadCoord(p.roadIndex) + p.side * SIDEWALK;
        } else {
          p.axis = 'h';
          p.roadIndex = nearestRoadIndex(p.y);
          p.y = roadCoord(p.roadIndex) + p.side * SIDEWALK;
        }
      }
      return;
    }

    // Walk along the sidewalk.
    const step = p.speed * p.dir * dt;
    if (p.axis === 'h') p.x += step;
    else p.y += step;

    // At a junction, sometimes cross to the other sidewalk or turn.
    const jx = roadCoord(nearestRoadIndex(p.x));
    const jy = roadCoord(nearestRoadIndex(p.y));
    const atJunction = Math.abs(p.x - jx) < 12 && Math.abs(p.y - jy) < 12;
    if (atJunction && rng() < dt * 0.5) {
      const roll = rng();
      if (roll < 0.25) {
        // Cross the road: switch sidewalk side.
        p.side = -p.side;
        if (p.axis === 'h') p.y = roadCoord(p.roadIndex) + p.side * SIDEWALK;
        else p.x = roadCoord(p.roadIndex) + p.side * SIDEWALK;
      } else if (roll < 0.5) {
        // Turn onto the crossing road.
        p.axis = p.axis === 'h' ? 'v' : 'h';
        p.dir = rng() < 0.5 ? 1 : -1;
        if (p.axis === 'h') {
          p.roadIndex = nearestRoadIndex(p.y);
          p.y = roadCoord(p.roadIndex) + p.side * SIDEWALK;
        } else {
          p.roadIndex = nearestRoadIndex(p.x);
          p.x = roadCoord(p.roadIndex) + p.side * SIDEWALK;
        }
      } else if (roll < 0.6) {
        p.dir = -p.dir; // turn around
      } else {
        p.pause = 0.5 + rng() * 2; // idle a moment
      }
    }

    // World edge: turn around instead of walking out.
    if (p.axis === 'h' && (p.x < 40 || p.x > WORLD - 40)) p.dir = -p.dir;
    if (p.axis === 'v' && (p.y < 40 || p.y > WORLD - 40)) p.dir = -p.dir;
    p.x = Math.max(20, Math.min(WORLD - 20, p.x));
    p.y = Math.max(20, Math.min(WORLD - 20, p.y));
  }

  return {
    update(dt) {
      // Drain scares the game queued this frame.
      if (Array.isArray(game.scares)) {
        for (const s of game.scares) this.scare(s.x, s.y, s.radius || 260);
        game.scares.length = 0;
      }
      const target = 26;
      if (people.length < target && rng() < 0.4) {
        const pl = game.player;
        spawnPerson(pl ? pl.x : undefined, pl ? pl.y : undefined);
      }
      const pl = game.player;
      if (people.length > target + 10) {
        people = people.filter((p) => {
          if (!pl) return true;
          return Math.hypot(p.x - pl.x, p.y - pl.y) < 900;
        });
      }
      for (const p of people) updatePerson(p, dt);
    },

    draw(ctx, cam) {
      if (!ctx) return;
      for (const p of people) {
        if (cam) {
          if (p.x < cam.x - 20 || p.x > cam.x + cam.w + 20 ||
              p.y < cam.y - 20 || p.y > cam.y + cam.h + 20) continue;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        // Shadow.
        ctx.fillStyle = 'rgba(20, 16, 60, 0.3)';
        ctx.beginPath();
        ctx.ellipse(2, 3, 6, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        const scared = p.state === 'flee';
        // Legs.
        ctx.fillStyle = p.pants;
        ctx.fillRect(-4, 1, 3, 7);
        ctx.fillRect(1, 1, 3, 7);
        // Body.
        ctx.fillStyle = p.shirt;
        ctx.fillRect(-5, -7, 10, 9);
        // Head.
        ctx.fillStyle = '#e8b98a';
        ctx.beginPath();
        ctx.arc(0, -10, 4, 0, Math.PI * 2);
        ctx.fill();
        if (scared) {
          // Panic mark above the head.
          ctx.fillStyle = '#ffdd00';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('!', 0, -18);
        }
        ctx.restore();
      }
    },

    list() { return people; },
    count() { return people.length; },

    scare(x, y, radius) {
      const r = radius || 260;
      for (const p of people) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < r) {
          p.state = 'flee';
          p.fleeX = x;
          p.fleeY = y;
          p.fleeTime = 2.5 + rng() * 2;
          p.speed = p.baseSpeed * 3.2;
        }
      }
    },

    // A carjacked driver: spawns at the car and runs away from the player.
    spawnFleeing(x, y, color) {
      const p = makePerson(x, y, { shirt: color || '#e74c3c' });
      p.state = 'flee';
      const pl = game.player;
      p.fleeX = pl ? pl.x : x + 100;
      p.fleeY = pl ? pl.y : y;
      p.fleeTime = 4;
      p.speed = p.baseSpeed * 3.2;
      people.push(p);
      return p;
    },

    clear() { people = []; },
  };
}

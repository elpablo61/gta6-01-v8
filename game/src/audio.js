// audio.js — Crescent Bay sound system (fresh from prose spec §1, §3.4).
//
// WebAudio synth only, no external assets. Two jobs:
//   1. RADIO — three procedural stations, R cycles, HUD shows the name
//      plus an animated equalizer. Station 1 ("Bay FM") is the default
//      on a new game. Music keeps playing through missions and free roam.
//   2. SFX — engine hum, crash, gunshots (per weapon), siren, pickup
//      chime, mission jingle, helicopter rotor chop, skid.
//
// The module never touches the DOM except through the callbacks the game
// passes in. It is safe to construct before any user gesture: the
// AudioContext is created lazily on the first init() call (which the game
// calls from a gesture handler) and every public method is a no-op until
// then, so headless / muted runs stay silent instead of throwing.
//
// Context object G (only what this module reads):
//   G.timeOfDay  — 0..24, unused here except for future ducking hooks
//   G.onRadioChange(name) — optional callback when the station changes
//
// Public API (returned by createAudio):
//   init()                 create/resume the AudioContext + master gain
//   setMuted(m) / isMuted()
//   nextStation() / setStation(i) / stationName() / stationIndex()
//   equalizerLevel()       0..1, drives the HUD equalizer animation
//   setEngine(speed01, on) engine hum follows car speed (0 = off)
//   setSiren(on)           police siren wail while wanted >= 1 star
//   setRotor(on)           helicopter rotor chop while the heli is up
//   sfx(name, opts)        one-shot: 'shot-pistol' | 'shot-smg' |
//                          'shot-shotgun' | 'crash' | 'skid' | 'pickup' |
//                          'crate' | 'success' | 'fail' | 'click' |
//                          'arrest' | 'splash' | 'horn'
//   update(dt)             scheduler tick (call every frame)

const STATIONS = [
  { name: 'Bay FM',      kind: 'synthwave', bpm: 112, root: 55.00 }, // A1
  { name: 'Harbor Jazz', kind: 'swing',     bpm: 96,  root: 65.41 }, // C2
  { name: 'Crescent Rock', kind: 'rock',    bpm: 132, root: 49.00 }, // G1
];

// 16-step patterns, semitone offsets from the station root.
const PATTERNS = {
  synthwave: {
    bass: [0, 0, 12, 0, 3, 0, 10, 0, 0, 0, 12, 0, 5, 0, 7, 10],
    lead: [24, -1, 27, -1, 31, -1, 27, 24, -1, 24, -1, 28, 31, 28, 27, -1],
    hat:  [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
  },
  swing: {
    bass: [0, -1, 7, -1, 5, -1, 7, -1, 0, -1, 7, -1, 10, -1, 7, 5],
    lead: [12, -1, 16, 19, -1, 16, -1, 12, -1, 14, 16, -1, 19, 16, 14, -1],
    hat:  [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0],
  },
  rock: {
    bass: [0, 0, 0, 12, 0, 0, 10, 0, 0, 0, 0, 12, 3, 3, 5, 7],
    lead: [12, -1, 12, 15, -1, 12, -1, 19, -1, 19, 15, -1, 12, -1, 10, -1],
    hat:  [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0],
  },
};

function semitoneFreq(root, semis) {
  return root * Math.pow(2, semis / 12);
}

export function createAudio(G) {
  const game = G || {};
  let ctx = null;
  let master = null;
  let musicGain = null;
  let sfxGain = null;
  let noiseBuf = null;
  let muted = false;
  let station = 0; // Bay FM is the default on New Game (spec §3.4)
  let step = 0;
  let nextStepTime = 0;
  let timer = null;
  let eqLevel = 0;
  let eqTarget = 0;

  // Continuous loops (engine / siren / rotor), created on demand.
  const loops = { engine: null, siren: null, rotor: null };

  function ensureCtx() {
    if (ctx) return true;
    const AC = (typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext)) || null;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.32;
    musicGain.connect(master);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(master);
    // Shared white-noise buffer for hats / crashes / rotor chop.
    const len = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  function startScheduler() {
    if (timer !== null || !ctx) return;
    nextStepTime = ctx.currentTime + 0.1;
    step = 0;
    timer = setInterval(scheduleAhead, 40);
  }

  function scheduleAhead() {
    if (!ctx) return;
    const st = STATIONS[station];
    const pat = PATTERNS[st.kind];
    const stepDur = 60 / st.bpm / 4; // 16th notes
    while (nextStepTime < ctx.currentTime + 0.18) {
      playStep(st, pat, step, nextStepTime, stepDur);
      step = (step + 1) % 16;
      nextStepTime += stepDur;
    }
  }

  function playStep(st, pat, s, t, stepDur) {
    const bassNote = pat.bass[s];
    if (bassNote >= 0) {
      const osc = ctx.createOscillator();
      osc.type = st.kind === 'rock' ? 'square' : 'sawtooth';
      osc.frequency.value = semitoneFreq(st.root, bassNote);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.8);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = st.kind === 'swing' ? 500 : 900;
      osc.connect(f); f.connect(g); g.connect(musicGain);
      osc.start(t); osc.stop(t + stepDur * 2);
      eqTarget = 0.9;
    }
    const leadNote = pat.lead[s];
    if (leadNote >= 0) {
      const osc = ctx.createOscillator();
      osc.type = st.kind === 'swing' ? 'sine' : 'triangle';
      osc.frequency.value = semitoneFreq(st.root, leadNote);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 2.2);
      osc.connect(g); g.connect(musicGain);
      osc.start(t); osc.stop(t + stepDur * 2.4);
      eqTarget = Math.max(eqTarget, 0.6);
    }
    if (pat.hat[s]) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 6000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      src.connect(f); f.connect(g); g.connect(musicGain);
      src.start(t); src.stop(t + 0.06);
    }
    if (s === 0) eqTarget = Math.max(eqTarget, 0.35);
  }

  function blip(type, freq0, freq1, dur, vol, when) {
    if (!ctx) return;
    const t = when || ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq0, t);
    if (freq1 !== freq0) osc.frequency.exponentialRampToValueAtTime(freq1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g); g.connect(sfxGain);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  function noiseHit(dur, vol, filterFreq, type) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    f.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(sfxGain);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // --- continuous loops -------------------------------------------------
  function makeLoop(kind) {
    if (!ctx) return null;
    if (kind === 'engine') {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 55;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 420;
      const g = ctx.createGain(); g.gain.value = 0;
      osc.connect(f); f.connect(g); g.connect(sfxGain);
      osc.start();
      return { osc, gain: g, filter: f };
    }
    if (kind === 'siren') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 700;
      const g = ctx.createGain(); g.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.55; // slow two-tone wail
      const lfoGain = ctx.createGain(); lfoGain.gain.value = 260;
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      osc.connect(g); g.connect(sfxGain);
      osc.start(); lfo.start();
      return { osc, gain: g, lfo };
    }
    // rotor: chopped noise, ~13 Hz blade chop
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 300;
    const chop = ctx.createGain(); chop.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square'; lfo.frequency.value = 13;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.45;
    lfo.connect(lfoGain); lfoGain.connect(chop.gain);
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(chop); chop.connect(g); g.connect(sfxGain);
    src.start(); lfo.start();
    return { src, gain: g, lfo };
  }

  function setLoop(kind, on, level) {
    if (!ctx) return;
    if (on && !loops[kind]) loops[kind] = makeLoop(kind);
    const loop = loops[kind];
    if (!loop) return;
    const target = on ? (level === undefined ? 1 : level) : 0;
    loop.gain.gain.setTargetAtTime(target * (kind === 'engine' ? 0.16 : 0.12),
      ctx.currentTime, 0.08);
    if (!on) {
      const dead = loop;
      setTimeout(() => {
        try {
          if (dead.osc) dead.osc.stop();
          if (dead.src) dead.src.stop();
          if (dead.lfo) dead.lfo.stop();
        } catch (e) { /* already stopped */ }
        if (loops[kind] === dead) loops[kind] = null;
      }, 400);
      loops[kind] = null;
    }
  }

  return {
    init() {
      if (!ensureCtx()) return false;
      if (ctx.state === 'suspended') ctx.resume();
      startScheduler();
      return true;
    },

    setMuted(m) {
      muted = !!m;
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
    },
    isMuted() { return muted; },

    nextStation() {
      this.setStation((station + 1) % STATIONS.length);
    },
    setStation(i) {
      const n = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length;
      if (n === station && timer !== null) return;
      station = n;
      step = 0;
      if (ctx) nextStepTime = Math.max(nextStepTime, ctx.currentTime + 0.05);
      if (typeof game.onRadioChange === 'function') game.onRadioChange(STATIONS[station].name);
    },
    stationName() { return STATIONS[station].name; },
    stationIndex() { return station; },
    stationNames() { return STATIONS.map((s) => s.name); },

    equalizerLevel() { return eqLevel; },

    setEngine(speed01, on) {
      if (!ctx) return;
      const s = Math.max(0, Math.min(1, speed01 || 0));
      setLoop('engine', !!on && s > 0.02, s);
      const loop = loops.engine;
      if (loop && on) {
        loop.osc.frequency.setTargetAtTime(50 + s * 170, ctx.currentTime, 0.05);
        loop.filter.frequency.setTargetAtTime(350 + s * 900, ctx.currentTime, 0.05);
      }
    },
    setSiren(on) { setLoop('siren', !!on, 1); },
    setRotor(on) { setLoop('rotor', !!on, 1); },

    sfx(name, opts) {
      if (!ctx) return;
      const o = opts || {};
      switch (name) {
        case 'shot-pistol':
          noiseHit(0.12, 0.7, 1800, 'highpass');
          blip('square', 220, 60, 0.09, 0.5);
          break;
        case 'shot-smg':
          noiseHit(0.08, 0.5, 2400, 'highpass');
          blip('square', 300, 90, 0.06, 0.35);
          break;
        case 'shot-shotgun':
          noiseHit(0.28, 0.9, 900);
          blip('sawtooth', 140, 40, 0.2, 0.6);
          break;
        case 'crash':
          noiseHit(0.35, 0.9, 500);
          blip('sine', 90, 35, 0.3, 0.7);
          break;
        case 'skid':
          noiseHit(0.25, 0.25, 3000, 'bandpass');
          break;
        case 'pickup':
          blip('sine', 660, 660, 0.08, 0.4);
          blip('sine', 990, 990, 0.12, 0.4, ctx.currentTime + 0.08);
          break;
        case 'crate':
          blip('triangle', 440, 440, 0.1, 0.5);
          blip('triangle', 660, 660, 0.1, 0.5, ctx.currentTime + 0.1);
          blip('triangle', 880, 880, 0.16, 0.5, ctx.currentTime + 0.2);
          break;
        case 'success': {
          const notes = [523, 659, 784, 1047];
          notes.forEach((n, i) => blip('triangle', n, n, 0.18, 0.45, ctx.currentTime + i * 0.11));
          break;
        }
        case 'fail': {
          const notes = [392, 330, 262];
          notes.forEach((n, i) => blip('sawtooth', n, n, 0.22, 0.3, ctx.currentTime + i * 0.14));
          break;
        }
        case 'horn':
          blip('square', 370, 370, 0.18, 0.3);
          blip('square', 466, 466, 0.18, 0.25);
          break;
        case 'arrest':
          blip('sawtooth', 500, 180, 0.6, 0.3);
          break;
        case 'splash':
          noiseHit(0.4, 0.5, 1200, 'bandpass');
          break;
        case 'click':
        default:
          blip('sine', 800, 800, 0.05, 0.3);
          break;
      }
      void o;
    },

    update(dt) {
      // Equalizer decays toward its target; the HUD reads equalizerLevel().
      eqLevel += (eqTarget - eqLevel) * Math.min(1, (dt || 0.016) * 8);
      eqTarget *= Math.max(0, 1 - (dt || 0.016) * 1.5);
      if (eqTarget < 0.05) eqTarget = 0.05;
    },
  };
}

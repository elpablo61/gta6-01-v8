// Audio — synth WebAudio sound (Crescent Bay).
//
// Fresh from prose spec §1 + brief A17. All sound is synthesized with
// WebAudio — no samples, no network, no external assets. The radio
// stations (Bay FM / Harbor Jazz / Crescent Rock) live in radio.js and
// are the music; this module owns the sound EFFECTS plus the music
// hook that starts the radio: playSiren, playGunshot, startMusicLoop
// are the first declarations, because they are the sounds the outline
// should show. Audio never breaks the game: the context is created
// lazily on the first user gesture (New Game click), every method is
// wrapped so a failure is silent, and in Node (no AudioContext) every
// call is a no-op that still updates the state the tests read.
//
// Shared-state contract (read defensively):
//   game.radio { start(), stop(), setStation(i) } — the station system;
//                startMusicLoop delegates to it when present.
//   game.muted / game.audio.muted — mute flag (this module's own flag
//                lives on its state; game.audio IS this module).
// Sound names the rest of the game calls through game.audio.play(name):
//   shoot-pistol / shoot-smg / shoot-shotgun, pickup, pickup-ammo,
//   pickup-health, weapon-switch, hurt, game-over, car-door, siren,
//   enemy-down, menu-open, menu-close, garage-buy, heli-hit, engine.

export function playSiren(audio) {
  if (audio && typeof audio.playSiren === 'function') return audio.playSiren();
  return false;
}

export function playGunshot(audio, weapon) {
  if (audio && typeof audio.playGunshot === 'function') return audio.playGunshot(weapon);
  return false;
}

export function startMusicLoop(audio) {
  if (audio && typeof audio.startMusicLoop === 'function') return audio.startMusicLoop();
  return null;
}

const AUDIO_MASTER_VOLUME = 0.5;
const AUDIO_EFFECT_VOLUME = 0.4;
const AUDIO_GUNSHOT_DURATION = 0.14;
const AUDIO_SIREN_PERIOD = 0.9;

export function createAudio(game) {
  const state = {
    context: null,
    masterGain: null,
    muted: false,
    started: false,
    musicPlaying: false,
    sirenNodes: null,
    engineNodes: null,
    soundsPlayed: {},
    lastPlayed: null,
  };

  function ensureContext() {
    if (state.context) return state.context;
    let Ctor = null;
    if (game && game.audioContext) {
      state.context = game.audioContext;
    } else if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      Ctor = window.AudioContext || window.webkitAudioContext;
      try {
        state.context = new Ctor();
      } catch (e) {
        state.context = null;
      }
    }
    if (state.context && !state.masterGain) {
      try {
        state.masterGain = state.context.createGain();
        state.masterGain.gain.value = state.muted ? 0 : AUDIO_MASTER_VOLUME;
        state.masterGain.connect(state.context.destination);
      } catch (e) {
        state.masterGain = null;
      }
    }
    return state.context;
  }

  // Resume the context after a user gesture (browsers start suspended).
  function resume() {
    const ac = ensureContext();
    if (ac && ac.state === 'suspended' && typeof ac.resume === 'function') {
      ac.resume().catch(() => {});
    }
    return !!ac;
  }

  function notePlayed(name) {
    state.soundsPlayed[name] = (state.soundsPlayed[name] || 0) + 1;
    state.lastPlayed = name;
  }

  // One oscillator blip: frequency, duration, wave, volume.
  function tone(freq, duration, wave, volume, delay) {
    const ac = ensureContext();
    if (!ac || !state.masterGain) return false;
    try {
      const t0 = ac.currentTime + (delay || 0);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = wave || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume || 0.2, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      osc.connect(gain);
      gain.connect(state.masterGain);
      osc.start(t0);
      osc.stop(t0 + duration + 0.05);
      return true;
    } catch (e) {
      return false;
    }
  }

  // A burst of filtered noise — gunshots, crashes, doors.
  function noiseBurst(duration, volume, lowpass) {
    const ac = ensureContext();
    if (!ac || !state.masterGain) return false;
    try {
      const len = Math.max(1, Math.floor(ac.sampleRate * duration));
      const buffer = ac.createBuffer(1, len, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const gain = ac.createGain();
      gain.gain.value = volume || 0.3;
      let node = src;
      if (lowpass) {
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = lowpass;
        src.connect(filter);
        node = filter;
      }
      node.connect(gain);
      gain.connect(state.masterGain);
      src.start();
      return true;
    } catch (e) {
      return false;
    }
  }

  function playGunshot(weapon) {
    notePlayed('shoot-' + (weapon || 'pistol'));
    if (weapon === 'shotgun') {
      noiseBurst(0.22, 0.5, 900);
      tone(90, 0.18, 'sawtooth', 0.3);
    } else if (weapon === 'smg') {
      noiseBurst(0.08, 0.3, 2400);
      tone(220, 0.06, 'square', 0.14);
    } else {
      noiseBurst(AUDIO_GUNSHOT_DURATION, AUDIO_EFFECT_VOLUME, 1800);
      tone(160, 0.1, 'square', 0.2);
    }
    return true;
  }

  function playSiren() {
    notePlayed('siren');
    const ac = ensureContext();
    if (!ac || !state.masterGain || state.sirenNodes) return !!state.sirenNodes;
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      gain.gain.value = 0.05;
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 1 / AUDIO_SIREN_PERIOD;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 220;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(gain);
      gain.connect(state.masterGain);
      osc.start();
      lfo.start();
      state.sirenNodes = { osc, lfo, gain };
      return true;
    } catch (e) {
      return false;
    }
  }

  function stopSiren() {
    if (!state.sirenNodes) return false;
    try {
      state.sirenNodes.osc.stop();
      state.sirenNodes.lfo.stop();
    } catch (e) { /* already stopped */ }
    state.sirenNodes = null;
    return true;
  }

  function playHurt() {
    notePlayed('hurt');
    tone(140, 0.18, 'sawtooth', 0.25);
    tone(90, 0.22, 'sawtooth', 0.2, 0.05);
    return true;
  }

  function playGameOver(reason) {
    notePlayed('game-over');
    const notes = reason === 'CAUGHT' ? [392, 330, 262] : [330, 262, 196];
    notes.forEach((f, i) => tone(f, 0.35, 'triangle', 0.25, i * 0.3));
    stopSiren();
    return true;
  }

  function playPickup() {
    notePlayed('pickup');
    tone(660, 0.08, 'sine', 0.25);
    tone(990, 0.12, 'sine', 0.25, 0.07);
    return true;
  }

  function playCarDoor() {
    notePlayed('car-door');
    noiseBurst(0.08, 0.25, 700);
    tone(120, 0.07, 'square', 0.12);
    return true;
  }

  // The music loop is the radio: delegate to radio.js when it exists.
  // Without a radio, fall back to a quiet driving bass pulse so the
  // game is never silent after New Game.
  function startMusicLoop() {
    state.started = true;
    state.musicPlaying = true;
    resume();
    if (game && game.radio && typeof game.radio.start === 'function') {
      try {
        const name = game.radio.start();
        notePlayed('music-loop');
        return name;
      } catch (e) { /* fall through to the fallback loop */ }
    }
    notePlayed('music-loop');
    // Fallback loop: a soft bass pulse every beat, scheduled lazily.
    if (typeof setInterval !== 'undefined' && !state._fallbackTimer) {
      state._fallbackTimer = setInterval(() => {
        if (!state.muted && state.musicPlaying) tone(55, 0.22, 'triangle', 0.12);
      }, 500);
    }
    return 'Bay FM';
  }

  function stopMusic() {
    state.musicPlaying = false;
    if (state._fallbackTimer && typeof clearInterval !== 'undefined') {
      clearInterval(state._fallbackTimer);
      state._fallbackTimer = null;
    }
    if (game && game.radio && typeof game.radio.stop === 'function') {
      try { game.radio.stop(); } catch (e) { /* ignore */ }
    }
    return true;
  }

  // Engine hum: a low oscillator whose pitch follows the car's speed
  // (0..1). Cheap, and silent when Rook is on foot.
  function setEngineLevel(level) {
    const ac = ensureContext();
    if (!ac || !state.masterGain) return false;
    const lvl = Math.max(0, Math.min(1, Number(level) || 0));
    if (lvl <= 0.02) {
      if (state.engineNodes) {
        try { state.engineNodes.osc.stop(); } catch (e) { /* ignore */ }
        state.engineNodes = null;
      }
      return true;
    }
    try {
      if (!state.engineNodes) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = 60;
        gain.gain.value = 0.04;
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 320;
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(state.masterGain);
        osc.start();
        state.engineNodes = { osc, gain };
      }
      state.engineNodes.osc.frequency.value = 55 + lvl * 130;
      state.engineNodes.gain.gain.value = 0.02 + lvl * 0.05;
      return true;
    } catch (e) {
      return false;
    }
  }

  function setMuted(muted) {
    state.muted = !!muted;
    if (state.masterGain) {
      try {
        state.masterGain.gain.value = state.muted ? 0 : AUDIO_MASTER_VOLUME;
      } catch (e) { /* ignore */ }
    }
    return state.muted;
  }

  // One dispatch for every sound name the game uses. Unknown names are
  // ignored (never throw), known names map to their synth.
  function play(name) {
    if (!name) return false;
    const n = String(name);
    if (n === 'shoot-pistol') return playGunshot('pistol');
    if (n === 'shoot-smg') return playGunshot('smg');
    if (n === 'shoot-shotgun') return playGunshot('shotgun');
    if (n === 'pickup' || n === 'pickup-ammo' || n === 'pickup-health') {
      notePlayed(n);
      if (n === 'pickup-health') tone(520, 0.1, 'sine', 0.25);
      return playPickup();
    }
    if (n === 'weapon-switch') { notePlayed(n); tone(440, 0.05, 'square', 0.15); return true; }
    if (n === 'hurt') return playHurt();
    if (n === 'game-over') return playGameOver();
    if (n === 'car-door' || n === 'carDoor') return playCarDoor();
    if (n === 'siren') return playSiren();
    if (n === 'siren-stop') return stopSiren();
    if (n === 'enemy-down') { notePlayed(n); tone(220, 0.15, 'square', 0.2); tone(110, 0.2, 'square', 0.2, 0.08); return true; }
    if (n === 'menu-open' || n === 'menu-close') { notePlayed(n); tone(n === 'menu-open' ? 520 : 380, 0.07, 'sine', 0.18); return true; }
    if (n === 'garage-buy') { notePlayed(n); tone(880, 0.1, 'sine', 0.25); tone(1320, 0.14, 'sine', 0.25, 0.08); return true; }
    if (n === 'heli-hit') { notePlayed(n); noiseBurst(0.12, 0.3, 1200); return true; }
    if (n === 'music-loop') return !!startMusicLoop();
    notePlayed(n);
    return false;
  }

  function snapshot() {
    return {
      started: state.started,
      musicPlaying: state.musicPlaying,
      muted: state.muted,
      sirenOn: !!state.sirenNodes,
      soundsPlayed: { ...state.soundsPlayed },
      lastPlayed: state.lastPlayed,
      hasContext: !!state.context,
    };
  }

  return {
    state,
    play,
    playGunshot,
    playSiren,
    stopSiren,
    playHurt,
    playGameOver,
    playPickup,
    playCarDoor,
    startMusicLoop,
    stopMusic,
    setEngineLevel,
    setMuted,
    resume,
    ensureContext,
    snapshot,
  };
}

export default createAudio;

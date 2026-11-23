// Radio — 3 stations. Crescent Bay. Fresh from prose spec §3.4.
// R cycles the radio station; the HUD shows the station name plus a small
// animated equalizer. Three stations, each a distinct procedural WebAudio
// loop — no samples, no network, no talk, music only:
//   "Bay FM"      — synthwave, driving bass.
//   "Harbor Jazz" — slow swing.
//   "Crescent Rock" — driving rock riff.
// Station 1 (Bay FM) is the default on New Game. The radio keeps playing
// through missions and free roam. This module replaces the old single
// music loop: there is one radio system, and it is this one.
// A scripted check can cycle all three stations and assert the displayed
// station name changes each time — see cycle() + stationName().
//
// Shared-state contract (read defensively; missing fields get defaults):
//   game.audioContext — an AudioContext the game owns (optional); when
//                absent this module creates one lazily on first user
//                gesture (start() / cycle()). In Node (no AudioContext)
//                the scheduler is a no-op but station state still cycles,
//                so scripted checks pass headless.
//   game.audio   { muted } — optional mute flag the radio respects.
//   game.time    { now } — seconds; drives the equalizer animation.
// The equalizer is driven by the beat phase, so it animates even when the
// audio context is suspended: drawEqualizer() never needs sound to move.

export const RADIO_STATIONS = [
  {
    id: 'bay-fm',
    name: 'Bay FM',
    tagline: 'synthwave, driving bass',
    bpm: 112,
    swing: 0,
    bassNotes: [0, 0, 7, 0, 10, 0, 7, 5],
    bassWave: 'sawtooth',
    chordNotes: [0, 3, 7, 10],
    chordWave: 'square',
    leadNotes: [12, 15, 19, 15, 12, 10, 7, 10],
    leadWave: 'sawtooth',
    rootMidi: 45,
    hatEvery: 0.5,
  },
  {
    id: 'harbor-jazz',
    name: 'Harbor Jazz',
    tagline: 'slow swing',
    bpm: 84,
    swing: 0.35,
    bassNotes: [0, 7, 5, 7, 0, 7, 10, 7],
    bassWave: 'triangle',
    chordNotes: [0, 4, 7, 11],
    chordWave: 'sine',
    leadNotes: [12, 11, 9, 7, 9, 11, 12, 14],
    leadWave: 'sine',
    rootMidi: 41,
    hatEvery: 1,
  },
  {
    id: 'crescent-rock',
    name: 'Crescent Rock',
    tagline: 'driving rock riff',
    bpm: 132,
    swing: 0,
    bassNotes: [0, 0, 0, 7, 0, 0, 5, 7],
    bassWave: 'square',
    chordNotes: [0, 5, 7, 12],
    chordWave: 'sawtooth',
    leadNotes: [12, 12, 15, 12, 19, 15, 12, 7],
    leadWave: 'square',
    rootMidi: 40,
    hatEvery: 0.5,
  },
];

export const RADIO_DEFAULT_STATION = 0;
export const EQUALIZER_BARS = 8;

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function createRadio(game) {
  const state = {
    index: RADIO_DEFAULT_STATION,
    playing: false,
    started: false,
    audioContext: null,
    masterGain: null,
    nextNoteTime: 0,
    step: 0,
    timerId: null,
    cycles: 0,
    stationHistory: [RADIO_STATIONS[RADIO_DEFAULT_STATION].name],
  };

  function currentStation() {
    return RADIO_STATIONS[state.index];
  }

  function stationName() {
    return currentStation().name;
  }

  function isMuted() {
    return !!(game && game.audio && game.audio.muted);
  }

  function ensureAudioContext() {
    if (state.audioContext) return state.audioContext;
    if (game && game.audioContext) {
      state.audioContext = game.audioContext;
    } else if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      try {
        state.audioContext = new Ctor();
      } catch (e) {
        state.audioContext = null;
      }
    }
    if (state.audioContext && !state.masterGain) {
      try {
        state.masterGain = state.audioContext.createGain();
        state.masterGain.gain.value = isMuted() ? 0 : 0.16;
        state.masterGain.connect(state.audioContext.destination);
      } catch (e) {
        state.masterGain = null;
      }
    }
    return state.audioContext;
  }

  function noteFrequency(midiOffset) {
    return midiToFrequency(currentStation().rootMidi + midiOffset);
  }

  function playTone(freq, at, duration, wave, volume) {
    const ac = state.audioContext;
    if (!ac || !state.masterGain) return;
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = wave || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(volume || 0.2, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
      osc.connect(gain);
      gain.connect(state.masterGain);
      osc.start(at);
      osc.stop(at + duration + 0.05);
    } catch (e) { /* a failed note never breaks the game */ }
  }

  // One sequencer step: bass note, chord stab on the bar, lead note, hat.
  function scheduleStep(step, at) {
    const station = currentStation();
    const beat = 60 / station.bpm;
    const stepDur = beat / 2;
    const swingShift = step % 2 === 1 ? station.swing * stepDur : 0;
    const t = at + swingShift;
    const bass = station.bassNotes[step % station.bassNotes.length];
    playTone(noteFrequency(bass), t, stepDur * 0.9, station.bassWave, 0.32);
    if (step % 4 === 0) {
      for (const chord of station.chordNotes) {
        playTone(noteFrequency(chord), t, stepDur * 1.8, station.chordWave, 0.07);
      }
    }
    const lead = station.leadNotes[step % station.leadNotes.length];
    playTone(noteFrequency(lead), t, stepDur * 0.8, station.leadWave, 0.1);
    if (step % 2 === 0) {
      playTone(5200, t, 0.03, 'square', 0.03);
    }
  }

  function schedulerTick() {
    const ac = state.audioContext;
    if (!ac || !state.playing) return;
    const station = currentStation();
    const stepDur = 60 / station.bpm / 2;
    while (state.nextNoteTime < ac.currentTime + 0.15) {
      scheduleStep(state.step, state.nextNoteTime);
      state.step += 1;
      state.nextNoteTime += stepDur;
    }
  }

  function startScheduler() {
    if (typeof setInterval === 'undefined') return;
    if (state.timerId !== null) return;
    state.timerId = setInterval(schedulerTick, 40);
  }

  function stopScheduler() {
    if (state.timerId !== null && typeof clearInterval !== 'undefined') {
      clearInterval(state.timerId);
    }
    state.timerId = null;
  }

  function start() {
    state.started = true;
    state.playing = true;
    const ac = ensureAudioContext();
    if (ac) {
      if (ac.state === 'suspended' && typeof ac.resume === 'function') {
        ac.resume().catch(() => {});
      }
      if (!state.nextNoteTime || state.nextNoteTime < ac.currentTime) {
        state.nextNoteTime = ac.currentTime + 0.05;
      }
      startScheduler();
    }
    if (game) game.radioStation = stationName();
    return stationName();
  }

  function stop() {
    state.playing = false;
    stopScheduler();
    return stationName();
  }

  function setStation(index) {
    const n = RADIO_STATIONS.length;
    const next = ((Math.floor(index) % n) + n) % n;
    if (next !== state.index) {
      state.index = next;
      state.step = 0;
      state.stationHistory.push(stationName());
      if (game) game.radioStation = stationName();
    }
    return stationName();
  }

  function cycle() {
    const name = setStation(state.index + 1);
    state.cycles += 1;
    if (state.started && !state.playing) start();
    return name;
  }

  // Scripted check helper: cycles through all three stations from the
  // current one and returns the station name seen after each press.
  function cycleAllStations() {
    const seen = [];
    for (let i = 0; i < RADIO_STATIONS.length; i++) {
      seen.push(cycle());
    }
    return seen;
  }

  function onKey(code) {
    if (code === 'KeyR') {
      cycle();
      return true;
    }
    return false;
  }

  function update() {
    if (state.masterGain && state.audioContext) {
      try {
        state.masterGain.gain.value = isMuted() ? 0 : 0.16;
      } catch (e) { /* ignore */ }
    }
    if (game) game.radioStation = stationName();
    return state;
  }

  // Beat phase in [0, 1): drives the equalizer even with no audio.
  function beatPhase() {
    const station = currentStation();
    let t = 0;
    if (game && game.time && typeof game.time.now === 'number') t = game.time.now;
    else t = Date.now() / 1000;
    const beat = 60 / station.bpm;
    return (t % beat) / beat;
  }

  function equalizerLevels() {
    const phase = beatPhase();
    const levels = [];
    for (let i = 0; i < EQUALIZER_BARS; i++) {
      const wave = Math.abs(Math.sin((phase + i * 0.37) * Math.PI * 2));
      levels.push(Math.round(wave * 100) / 100);
    }
    return levels;
  }

  function drawEqualizer(ctx, x, y, width, height) {
    if (!ctx) return;
    const levels = equalizerLevels();
    const barW = width / EQUALIZER_BARS;
    for (let i = 0; i < EQUALIZER_BARS; i++) {
      const barH = Math.max(2, levels[i] * height);
      ctx.fillStyle = i % 2 === 0 ? '#1abc9c' : '#f1c40f';
      ctx.fillRect(x + i * barW + 1, y + height - barH, barW - 2, barH);
    }
  }

  function hudText() {
    return { station: stationName(), tagline: currentStation().tagline };
  }

  function snapshot() {
    return {
      station: stationName(),
      index: state.index,
      playing: state.playing,
      cycles: state.cycles,
      history: [...state.stationHistory],
    };
  }

  return {
    state,
    stations: RADIO_STATIONS,
    start,
    stop,
    cycle,
    setStation,
    cycleAllStations,
    currentStation,
    stationName,
    onKey,
    update,
    beatPhase,
    equalizerLevels,
    drawEqualizer,
    hudText,
    snapshot,
  };
}

export default createRadio;

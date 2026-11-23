// radio.js — Radio with 3 stations (prose spec §3.4).
// R cycles the radio station; the HUD shows the station name plus a
// small animated equalizer. Three stations, each a distinct procedural
// WebAudio loop: "Bay FM" (synthwave, driving bass), "Harbor Jazz"
// (slow swing), "Crescent Rock" (driving rock riff). Station 1 is the
// default on New Game. The radio keeps playing through missions and
// free roam. It is music only (no talk). The old single music loop is
// replaced by this station system. A scripted check must cycle all
// three stations and assert the displayed station name changes.

export const STATIONS = [
  { id: 'bayfm', name: 'Bay FM', genre: 'synthwave', bpm: 112 },
  { id: 'harborjazz', name: 'Harbor Jazz', genre: 'jazz', bpm: 84 },
  { id: 'crescentrock', name: 'Crescent Rock', genre: 'rock', bpm: 132 },
];
export const DEFAULT_STATION = 0; // Bay FM on New Game

// Note frequencies (Hz) used by the procedural loops.
const NOTE = {
  C2: 65.41, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98.0, A2: 110.0, B2: 123.47,
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.0,
};

// Each station is a 16-step loop: bass line + lead riff.
// Steps are eighth notes at the station's BPM.
const PATTERNS = {
  bayfm: {
    // Synthwave: driving octave bass, bright saw lead.
    bass: ['C2', 'C2', 'C3', 'C2', 'G2', 'G2', 'G3', 'G2', 'A2', 'A2', 'A3', 'A2', 'F2', 'F2', 'G2', 'G2'],
    lead: ['C4', null, 'E4', null, 'G4', null, 'A4', null, 'G4', null, 'E4', null, 'D4', null, 'E4', 'G4'],
    wave: 'sawtooth',
    bassGain: 0.16,
    leadGain: 0.07,
  },
  harborjazz: {
    // Slow swing: walking bass, mellow triangle melody.
    bass: ['C2', 'E2', 'G2', 'A2', 'F2', 'A2', 'C3', 'G2', 'C2', 'E2', 'G2', 'B2', 'A2', 'G2', 'F2', 'G2'],
    lead: ['E4', null, 'G4', null, 'A4', 'G4', 'E4', null, 'D4', 'E4', 'C4', null, 'B3', 'C4', null, null],
    wave: 'triangle',
    bassGain: 0.13,
    leadGain: 0.08,
  },
  crescentrock: {
    // Driving rock riff: punchy root bass, square lead.
    bass: ['E2', 'E2', 'E2', 'G2', 'E2', 'E2', 'A2', 'G2', 'E2', 'E2', 'E2', 'G2', 'D2', 'D2', 'G2', 'A2'],
    lead: ['E4', 'G4', 'A4', 'G4', 'E4', null, 'D4', 'E4', 'E4', 'G4', 'A4', 'C5', 'B4', 'A4', 'G4', 'E4'],
    wave: 'square',
    bassGain: 0.12,
    leadGain: 0.05,
  },
};

export function createRadio() {
  const radio = {
    stationIndex: DEFAULT_STATION,
    playing: false,
    eqLevel: 0, // 0..1 animated equalizer level for the HUD
    step: 0,
  };

  let audioCtx = null;
  let timerId = null;
  let masterGain = null;

  function station() {
    return STATIONS[radio.stationIndex];
  }

  function stationName() {
    return station().name;
  }

  function ensureAudio() {
    if (audioCtx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      audioCtx = new AC();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(audioCtx.destination);
    } catch (e) {
      return false;
    }
    return true;
  }

  function playNote(freq, when, duration, wave, gainValue) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainValue, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(when);
    osc.stop(when + duration + 0.02);
  }

  function scheduleStep() {
    if (!audioCtx) return;
    const st = station();
    const pat = PATTERNS[st.id];
    const stepDur = 60 / st.bpm / 2; // eighth notes
    const now = audioCtx.currentTime;
    const bassNote = pat.bass[radio.step % 16];
    const leadNote = pat.lead[radio.step % 16];
    if (bassNote) playNote(NOTE[bassNote], now, stepDur * 0.95, 'sine', pat.bassGain);
    if (leadNote) playNote(NOTE[leadNote], now, stepDur * 0.9, pat.wave, pat.leadGain);
    // Equalizer level pulses on bass steps.
    radio.eqLevel = bassNote ? 0.9 : 0.35;
    radio.step = (radio.step + 1) % 16;
    timerId = setTimeout(scheduleStep, stepDur * 1000);
  }

  function start() {
    if (radio.playing) return;
    if (!ensureAudio()) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    radio.playing = true;
    radio.step = 0;
    scheduleStep();
  }

  function stop() {
    radio.playing = false;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  // R: cycle to the next station. Keeps playing; the loop pattern
  // switches on the next scheduled step.
  function cycle() {
    radio.stationIndex = (radio.stationIndex + 1) % STATIONS.length;
    radio.step = 0;
    return stationName();
  }

  function setStation(index) {
    radio.stationIndex = ((index % STATIONS.length) + STATIONS.length) % STATIONS.length;
    radio.step = 0;
    return stationName();
  }

  // HUD: station name + a small animated equalizer (5 bars).
  function drawHud(ctx, x, y) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`♪ ${stationName()}`, x, y);
    const bars = 5;
    for (let i = 0; i < bars; i++) {
      const h = 4 + radio.eqLevel * 10 * (0.5 + 0.5 * Math.sin(Date.now() / 90 + i * 1.3));
      ctx.fillStyle = '#fca311';
      ctx.fillRect(x + i * 8, y + 8 - h, 5, h);
    }
    // Equalizer decays between bass steps so the bars animate.
    radio.eqLevel = Math.max(0.15, radio.eqLevel * 0.94);
  }

  function serialize() {
    return { stationIndex: radio.stationIndex };
  }

  function deserialize(data) {
    if (data && typeof data.stationIndex === 'number') {
      setStation(data.stationIndex);
    }
  }

  return {
    radio,
    station,
    stationName,
    start,
    stop,
    cycle,
    setStation,
    drawHud,
    serialize,
    deserialize,
  };
}

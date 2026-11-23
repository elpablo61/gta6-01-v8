// Saves — 3 slots. Crescent Bay. Fresh from prose spec §3.5.
// The title screen lists 3 save slots. Each slot shows mission progress
// (the highest mission reached), cash, and date — or "Empty". Continue
// loads a chosen slot. Autosave after each mission writes to the active
// slot. Manual save from the pause menu writes to the active slot.
// Keys are versioned, one per slot, with a fallback: a corrupt slot shows
// as corrupt and can be overwritten — it never crashes the title screen.
// The old single-slot behaviour is kept as the default active slot when
// a save already exists: a legacy single save migrates into slot 0 and
// slot 0 stays the active slot unless the player picks another.
//
// Storage contract: this module takes an optional storage object with
// getItem / setItem / removeItem (localStorage shape). When none is given
// it uses localStorage when present, otherwise an in-memory store (so the
// module loads and tests cleanly in Node). Nothing here ever throws on a
// corrupt or missing slot: listSlots() reports status 'corrupt' instead.
// Slot payload: { version, savedAt, mission, cash, player, ...rest }.
// `mission` is the highest mission reached as a number (m1 -> 1) or the
// mission id string the caller passes; summaries normalise it for display.

export const SAVE_VERSION = 1;
export const SAVE_SLOT_COUNT = 3;
export const SAVE_KEY_PREFIX = 'crescent-bay-save-v1-slot-';
export const SAVE_KEY_LEGACY = 'crescent-bay-save-v1';
export const SAVE_ACTIVE_SLOT_KEY = 'crescent-bay-active-slot-v1';

export function saveKeyForSlot(slot) {
  return SAVE_KEY_PREFIX + slot;
}

export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

export function resolveStorage(provided) {
  if (provided && typeof provided.getItem === 'function') return provided;
  if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  return createMemoryStorage();
}

export function parseSlotPayload(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'corrupt json' };
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'not an object' };
  if (data.version !== SAVE_VERSION) return { ok: false, reason: 'version mismatch' };
  return { ok: true, data };
}

export function missionLabel(mission) {
  if (typeof mission === 'number' && mission > 0) return 'Mission ' + mission;
  if (typeof mission === 'string' && mission.length > 0) return mission.toUpperCase();
  return 'No mission yet';
}

export function createSaveSlots(storage) {
  const store = resolveStorage(storage);
  let activeSlot = 0;
  let migratedLegacy = false;

  function readRaw(slot) {
    try {
      return store.getItem(saveKeyForSlot(slot));
    } catch (e) {
      return null;
    }
  }

  function writeRaw(slot, raw) {
    try {
      store.setItem(saveKeyForSlot(slot), raw);
      return true;
    } catch (e) {
      return false;
    }
  }

  function readActiveSlot() {
    try {
      const raw = store.getItem(SAVE_ACTIVE_SLOT_KEY);
      const n = raw === null ? NaN : parseInt(raw, 10);
      if (!Number.isNaN(n) && n >= 0 && n < SAVE_SLOT_COUNT) return n;
    } catch (e) { /* fall through to default */ }
    return 0;
  }

  function writeActiveSlot(slot) {
    try {
      store.setItem(SAVE_ACTIVE_SLOT_KEY, String(slot));
    } catch (e) { /* active slot is best-effort */ }
  }

  // Legacy single save (pre-slot key) migrates into slot 0 once, so an
  // existing player keeps their progress and slot 0 stays the default.
  function migrateLegacySave() {
    if (migratedLegacy) return false;
    migratedLegacy = true;
    let raw = null;
    try {
      raw = store.getItem(SAVE_KEY_LEGACY);
    } catch (e) {
      return false;
    }
    if (raw === null || raw === undefined) return false;
    if (readRaw(0) !== null) return false;
    const parsed = parseSlotPayload(raw);
    if (!parsed.ok) return false;
    writeRaw(0, raw);
    try {
      store.removeItem(SAVE_KEY_LEGACY);
    } catch (e) { /* keep the legacy key if removal fails */ }
    activeSlot = 0;
    writeActiveSlot(0);
    return true;
  }

  function slotSummary(slot) {
    const raw = readRaw(slot);
    if (raw === null || raw === undefined) {
      return { slot, status: 'empty', label: 'Empty', mission: null, cash: null, date: null };
    }
    const parsed = parseSlotPayload(raw);
    if (!parsed.ok) {
      return {
        slot,
        status: 'corrupt',
        label: 'Corrupt — can be overwritten',
        mission: null,
        cash: null,
        date: null,
        reason: parsed.reason,
      };
    }
    const data = parsed.data;
    return {
      slot,
      status: 'ok',
      label: missionLabel(data.mission) + ' — $' + (typeof data.cash === 'number' ? data.cash : 0),
      mission: data.mission ?? null,
      cash: typeof data.cash === 'number' ? data.cash : null,
      date: data.savedAt || null,
    };
  }

  function listSlots() {
    const out = [];
    for (let slot = 0; slot < SAVE_SLOT_COUNT; slot++) {
      out.push(slotSummary(slot));
    }
    return out;
  }

  function buildPayload(state) {
    const s = state || {};
    return {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      mission: s.mission ?? s.highestMission ?? null,
      cash: typeof s.cash === 'number' ? s.cash : 0,
      player: s.player ? { ...s.player } : null,
      completedMissions: Array.isArray(s.completedMissions) ? [...s.completedMissions] : [],
      weapons: s.weapons ? { ...s.weapons } : null,
      radioStation: s.radioStation ?? null,
      extra: s.extra ? { ...s.extra } : {},
    };
  }

  function saveToSlot(slot, state) {
    if (slot < 0 || slot >= SAVE_SLOT_COUNT) return { ok: false, reason: 'bad slot' };
    const payload = buildPayload(state);
    const ok = writeRaw(slot, JSON.stringify(payload));
    if (ok) {
      activeSlot = slot;
      writeActiveSlot(slot);
    }
    return ok ? { ok: true, slot, savedAt: payload.savedAt } : { ok: false, reason: 'write failed' };
  }

  function loadFromSlot(slot) {
    if (slot < 0 || slot >= SAVE_SLOT_COUNT) return { ok: false, reason: 'bad slot' };
    const raw = readRaw(slot);
    if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
    const parsed = parseSlotPayload(raw);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    activeSlot = slot;
    writeActiveSlot(slot);
    return { ok: true, slot, data: parsed.data };
  }

  // Autosave after a mission completes: writes to the active slot.
  function autosave(state) {
    return saveToSlot(activeSlot, state);
  }

  // Manual save from the pause menu: writes to the active slot.
  function manualSave(state) {
    return saveToSlot(activeSlot, state);
  }

  function setActiveSlot(slot) {
    if (slot < 0 || slot >= SAVE_SLOT_COUNT) return false;
    activeSlot = slot;
    writeActiveSlot(slot);
    return true;
  }

  function getActiveSlot() {
    return activeSlot;
  }

  // Overwrite a slot even when it is corrupt: write fresh payload over it.
  function overwriteSlot(slot, state) {
    return saveToSlot(slot, state);
  }

  function clearSlot(slot) {
    if (slot < 0 || slot >= SAVE_SLOT_COUNT) return false;
    try {
      store.removeItem(saveKeyForSlot(slot));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Title-screen helper: one row per slot, safe to render as-is; corrupt
  // slots never throw, they render as corrupt with an overwrite affordance.
  function titleScreenRows() {
    return listSlots().map((s) => ({
      slot: s.slot,
      status: s.status,
      title: s.status === 'empty'
        ? 'Slot ' + (s.slot + 1) + ' — Empty'
        : s.status === 'corrupt'
          ? 'Slot ' + (s.slot + 1) + ' — Corrupt save'
          : 'Slot ' + (s.slot + 1) + ' — ' + missionLabel(s.mission),
      detail: s.status === 'ok'
        ? 'Cash $' + s.cash + ' · ' + (s.date ? s.date.slice(0, 10) : '')
        : s.status === 'corrupt'
          ? 'This save is damaged and can be overwritten.'
          : 'No save yet.',
      canContinue: s.status === 'ok',
      canOverwrite: s.status !== 'ok' || true,
    }));
  }

  // DOM builder for the title screen slot list (guarded: no-op in Node).
  function buildSlotListElement(onContinue) {
    if (typeof document === 'undefined') return null;
    const wrap = document.createElement('div');
    wrap.id = 'save-slot-list';
    for (const row of titleScreenRows()) {
      const div = document.createElement('div');
      div.className = 'save-slot save-slot-' + row.status;
      div.id = 'save-slot-' + row.slot;
      div.textContent = row.title + ' — ' + row.detail;
      if (row.canContinue && typeof onContinue === 'function') {
        const btn = document.createElement('button');
        btn.textContent = 'Continue';
        btn.addEventListener('click', () => onContinue(row.slot));
        div.appendChild(btn);
      }
      wrap.appendChild(div);
    }
    return wrap;
  }

  // Initialise: read the stored active slot, then migrate a legacy save.
  activeSlot = readActiveSlot();
  migrateLegacySave();

  return {
    listSlots,
    slotSummary,
    saveToSlot,
    loadFromSlot,
    autosave,
    manualSave,
    setActiveSlot,
    getActiveSlot,
    overwriteSlot,
    clearSlot,
    migrateLegacySave,
    titleScreenRows,
    buildSlotListElement,
    buildPayload,
  };
}

// Convenience wrappers kept for the main loop's save calls.
export function saveGameToSlot(slot, state, storage) {
  return createSaveSlots(storage).saveToSlot(slot, state);
}

export function loadGameFromSlot(slot, storage) {
  return createSaveSlots(storage).loadFromSlot(slot);
}

export function autosaveGame(state, storage) {
  return createSaveSlots(storage).autosave(state);
}

export default createSaveSlots;

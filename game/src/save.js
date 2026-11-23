// save.js — Save game, 3 slots (prose spec §3.5).
// Title screen lists 3 save slots; each slot shows mission progress
// (highest mission reached), cash, and date — or "Empty". Continue
// loads a chosen slot. Autosave after each mission writes to the
// active slot. Manual save from the pause menu writes to the active
// slot. Versioned localStorage keys (one per slot) with a fallback: a
// corrupt slot shows as corrupt and can be overwritten, never crashes
// the title screen. Keep the single-slot behaviour as the default
// active slot when a save already exists.

export const SAVE_VERSION = 4;
export const SLOT_COUNT = 3;
export const ACTIVE_SLOT_DEFAULT = 0;

function keyForSlot(slot) {
  return `crescent-bay-save-v${SAVE_VERSION}-slot-${slot}`;
}

// Legacy single-slot key from v3 (no slot suffix). When a save already
// exists there and no slotted save does, it becomes the default active
// slot (slot 0) so old progress is not lost.
const LEGACY_KEY = 'crescent-bay-save-v3';

export function createSaveSystem() {
  const saves = {
    activeSlot: ACTIVE_SLOT_DEFAULT,
  };

  function readRaw(slot) {
    try {
      return localStorage.getItem(keyForSlot(slot));
    } catch (e) {
      return null;
    }
  }

  // Returns the parsed save data for a slot, or null when empty.
  // A corrupt slot returns { corrupt: true } instead of throwing,
  // so the title screen never crashes on bad data.
  function readSlot(slot) {
    if (slot < 0 || slot >= SLOT_COUNT) return null;
    const raw = readRaw(slot);
    if (raw === null || raw === undefined) {
      // Legacy fallback: a v3 single-slot save counts as slot 0.
      if (slot === 0) {
        try {
          const legacy = localStorage.getItem(LEGACY_KEY);
          if (legacy) {
            const data = JSON.parse(legacy);
            return { ...data, legacy: true };
          }
        } catch (e) {
          return { corrupt: true };
        }
      }
      return null;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || data.version !== SAVE_VERSION) {
        return { corrupt: true };
      }
      return data;
    } catch (e) {
      return { corrupt: true };
    }
  }

  // Slot summary for the title screen: mission progress, cash, date —
  // or "Empty" / "Corrupt" (overwritable, never a crash).
  function slotSummary(slot) {
    const data = readSlot(slot);
    if (data === null) return { slot, status: 'empty', label: 'Empty' };
    if (data.corrupt) return { slot, status: 'corrupt', label: 'Corrupt — can be overwritten' };
    const mission = data.highestMission || 0;
    const cash = typeof data.cash === 'number' ? data.cash : 0;
    const date = data.savedAt ? new Date(data.savedAt).toLocaleString() : '—';
    return {
      slot,
      status: 'ok',
      label: `Mission ${mission}/12 · $${cash} · ${date}`,
      highestMission: mission,
      cash,
      savedAt: data.savedAt,
    };
  }

  function listSlots() {
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) out.push(slotSummary(i));
    return out;
  }

  // Build a save payload from the game's live state. The caller passes
  // a snapshot object; this module stamps version + date.
  function buildPayload(snapshot) {
    return {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      highestMission: snapshot.highestMission || 0,
      cash: snapshot.cash || 0,
      player: snapshot.player || null,
      weapons: snapshot.weapons || null,
      radio: snapshot.radio || null,
      missions: snapshot.missions || null,
      garage: snapshot.garage || null,
    };
  }

  function writeSlot(slot, payload) {
    if (slot < 0 || slot >= SLOT_COUNT) return false;
    try {
      localStorage.setItem(keyForSlot(slot), JSON.stringify(payload));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Write the active slot. Used by autosave (after each mission) and
  // by manual save from the pause menu.
  function saveActive(snapshot) {
    return writeSlot(saves.activeSlot, buildPayload(snapshot));
  }

  function saveToSlot(slot, snapshot) {
    return writeSlot(slot, buildPayload(snapshot));
  }

  // Continue: load a chosen slot. Returns the save data, or null when
  // the slot is empty/corrupt (the caller then starts a new game).
  function loadSlot(slot) {
    const data = readSlot(slot);
    if (!data || data.corrupt) return null;
    saves.activeSlot = slot;
    return data;
  }

  function setActiveSlot(slot) {
    if (slot >= 0 && slot < SLOT_COUNT) saves.activeSlot = slot;
  }

  function deleteSlot(slot) {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    try {
      localStorage.removeItem(keyForSlot(slot));
    } catch (e) {
      // Storage unavailable — nothing to delete.
    }
  }

  // DOM: render the 3-slot list into a container on the title screen.
  // onSelect(slot) is called when the player picks a slot to continue;
  // onNew(slot) when the player starts a new game in a slot.
  function renderSlotList(container, onSelect, onNew) {
    if (!container) return;
    container.innerHTML = '';
    const slots = listSlots();
    for (const s of slots) {
      const row = document.createElement('div');
      row.className = 'save-slot';
      row.dataset.slot = String(s.slot);
      const label = s.status === 'ok' ? s.label : s.label;
      row.innerHTML = `<strong>Slot ${s.slot + 1}</strong> — ${label}`;
      const btn = document.createElement('button');
      if (s.status === 'ok') {
        btn.textContent = 'Continue';
        btn.addEventListener('click', () => onSelect && onSelect(s.slot));
      } else {
        btn.textContent = s.status === 'corrupt' ? 'New Game (overwrite)' : 'New Game';
        btn.addEventListener('click', () => onNew && onNew(s.slot));
      }
      row.appendChild(btn);
      container.appendChild(row);
    }
  }

  return {
    saves,
    keyForSlot,
    readSlot,
    slotSummary,
    listSlots,
    buildPayload,
    saveActive,
    saveToSlot,
    loadSlot,
    setActiveSlot,
    deleteSlot,
    renderSlotList,
  };
}

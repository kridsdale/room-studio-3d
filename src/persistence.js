// Configuration Persistence System for Room Studio 3D
// Supports:
//   1. Full-state auto-save (room dimensions, furniture, finishes, lighting, units, fisheye lens, overlays, budget cap)
//   2. Unlimited named saved configurations (Save, Load, Overwrite, Rename, Delete, Compare IKEA cost)
//   3. Dual browser persistence (localStorage + IndexedDB mirror with storage-availability detection)
//   4. Portable .json file Export / Import (single plan OR full backup bundle) + Copy/Paste JSON transfer

export const CONFIG_SCHEMA = 'room-studio-config/v2';
export const BACKUP_SCHEMA = 'room-studio-backup/v2';

export const AUTO_STATE_KEY = 'room_planner_v5_autosave';
export const LEGACY_STATE_KEY = 'room_planner_v4_state';
export const SAVED_CONFIGS_KEY = 'room_planner_v5_configs';
export const LEGACY_SLOTS_KEY = 'room_planner_save_slots_v1';

const IDB_NAME = 'room_studio_persistence_db';
const IDB_STORE = 'kv';

function normDeg(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 0;
  let r = Math.round(n) % 360;
  if (r < 0) r += 360;
  return r;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function detectLocalStorageAvailable() {
  try {
    const testKey = '__rs_storage_probe__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch (_) {
    return false;
  }
}

// Lightweight IndexedDB mirror (gracefully no-ops in restricted sandboxes)
function openIDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

export async function idbSet(key, value) {
  const db = await openIDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

export async function idbGet(key) {
  const db = await openIDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

export function buildConfigSnapshot(state, name = 'Current Configuration', budgetCap = 1200, allCatalog = null) {
  const dynamicCatalog = {};
  const hotlistIds = Array.isArray(state.hotlistIds) ? Array.from(new Set(state.hotlistIds.filter(Boolean))) : [];
  if (allCatalog) {
    for (const it of state.items || []) {
      const c = allCatalog[it.catalogId];
      if (c && c.liveRenton && !dynamicCatalog[c.id]) {
        dynamicCatalog[c.id] = { ...c };
      }
    }
    for (const hid of hotlistIds) {
      const c = allCatalog[hid];
      if (c && c.liveRenton && !dynamicCatalog[c.id]) {
        dynamicCatalog[c.id] = { ...c };
      }
    }
  }
  return {
    schema: CONFIG_SCHEMA,
    savedAt: new Date().toISOString(),
    name: String(name || 'Untitled Layout').trim().slice(0, 80),
    room: { ...state.room },
    retainedDeskId: state.retainedDeskId || 'retained_wood_desk',
    hotlistIds,
    hotlistOnly: !!state.hotlistOnly,
    items: (state.items || []).map(({ uid, catalogId, x, z, rotDeg, finish, expanded, frontStyle, frontFinish, hardware, doorsOpen, mountHeightIn }) => ({
      uid,
      catalogId,
      x: Math.round(Number(x) * 100) / 100,
      z: Math.round(Number(z) * 100) / 100,
      rotDeg: normDeg(rotDeg),
      finish,
      expanded: !!expanded,
      ...(frontStyle ? { frontStyle } : {}),
      ...(frontFinish ? { frontFinish } : {}),
      ...(hardware && hardware !== 'auto' ? { hardware } : {}),
      ...(doorsOpen ? { doorsOpen: true } : {}),
      ...(Number.isFinite(Number(mountHeightIn)) ? { mountHeightIn: Math.round(Number(mountHeightIn)) } : {}),
    })),
    ...(Object.keys(dynamicCatalog).length > 0 ? { dynamicCatalog } : {}),
    settings: {
      units: state.units === 'metric' ? 'metric' : 'imperial',
      lightingMood: state.lightingMood === 'evening' ? 'evening' : 'day',
      wallMode: ['cutaway', 'up', 'down'].includes(state.wallMode) ? state.wallMode : 'cutaway',
      fisheyeMode: ['equidistant', 'panini', 'stereographic', 'rectilinear'].includes(state.fisheyeMode)
        ? state.fisheyeMode
        : 'equidistant',
      fisheyeFovDeg: clampNum(state.fisheyeFovDeg, 90, 180, 138),
      eyeVantage: ['doorway', 'nw', 'ne', 'se', 'center'].includes(state.eyeVantage) ? state.eyeVantage : 'doorway',
      eyeHeightIn: clampNum(state.eyeHeightIn, 24, 86, 61),
      showGrid: state.showGrid !== false,
      showClearances: state.showClearances !== false,
      showDimensions: state.showDimensions !== false,
      wallSnap: state.wallSnap !== false,
      closetOpen: state.closetOpen !== false,
      entryDoorOpen: state.entryDoorOpen !== false,
      cabinetDoorsOpen: !!state.cabinetDoorsOpen,
      budgetCap: clampNum(budgetCap, 0, 50000, 1200),
    },
  };
}

export function validateAndNormalizeConfig(raw, allCatalog, defaultRoom) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Configuration must be a valid JSON object.' };
  }

  // Handle full backup bundle transparently
  if (raw.schema === BACKUP_SCHEMA && Array.isArray(raw.savedConfigs)) {
    const validPlans = [];
    for (const p of raw.savedConfigs) {
      const res = validateAndNormalizeConfig(p, allCatalog, defaultRoom);
      if (res.ok) {
        validPlans.push({
          id: typeof p.id === 'string' && p.id ? p.id : `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ...res.config,
        });
      }
    }
    const curRes = raw.current ? validateAndNormalizeConfig(raw.current, allCatalog, defaultRoom) : null;
    if (!curRes?.ok && validPlans.length === 0) {
      return { ok: false, error: 'Backup file contains no valid room configurations.' };
    }
    return {
      ok: true,
      isBackup: true,
      current: curRes?.ok ? curRes.config : validPlans[0],
      savedConfigs: validPlans,
      warnings: curRes?.warnings || [],
    };
  }

  if (!Array.isArray(raw.items)) {
    return { ok: false, error: 'Missing "items" array in configuration JSON.' };
  }

  // Re-register any embedded live-looked-up Renton catalog definitions before validating items
  const dynamicCatalog = {};
  if (raw.dynamicCatalog && typeof raw.dynamicCatalog === 'object') {
    for (const [k, def] of Object.entries(raw.dynamicCatalog)) {
      if (def && typeof def === 'object' && def.id && def.w && def.d && def.h) {
        dynamicCatalog[k] = def;
        if (!allCatalog[def.id]) allCatalog[def.id] = def;
      }
    }
  }

  const warnings = [];
  const rawRoom = raw.room && typeof raw.room === 'object' ? raw.room : {};
  const room = {
    ...defaultRoom,
    widthIn: clampNum(rawRoom.widthIn, 72, 240, defaultRoom.widthIn),
    lengthIn: clampNum(rawRoom.lengthIn, 96, 300, defaultRoom.lengthIn),
    heightIn: clampNum(rawRoom.heightIn, 84, 144, defaultRoom.heightIn),
    swFlareWidthIn: clampNum(rawRoom.swFlareWidthIn, 0, 48, defaultRoom.swFlareWidthIn ?? 12),
    swFlareLengthIn: clampNum(rawRoom.swFlareLengthIn, 0, 120, defaultRoom.swFlareLengthIn ?? 46),
  };

  const usedUids = new Set();
  const items = [];
  for (let i = 0; i < raw.items.length; i++) {
    const it = raw.items[i];
    if (!it || typeof it !== 'object') continue;
    const cat = allCatalog[it.catalogId];
    if (!cat) {
      warnings.push(`Skipped unknown item "${it.catalogId}"`);
      continue;
    }
    let uid = typeof it.uid === 'string' && it.uid.trim() ? it.uid.trim() : `item_${Date.now()}_${i}`;
    while (usedUids.has(uid)) uid = `${uid}_${i}`;
    usedUids.add(uid);

    const finish =
      it.finish && Array.isArray(cat.finishes) && cat.finishes.includes(it.finish)
        ? it.finish
        : cat.defaultFinish;

    const maxMountH = Math.max(24, (room.heightIn || 96) - (cat.h || 14) - 1);
    items.push({
      uid,
      catalogId: cat.id,
      x: clampNum(it.x, -room.widthIn, room.widthIn, 0),
      z: clampNum(it.z, -room.lengthIn, room.lengthIn, 0),
      rotDeg: normDeg(it.rotDeg),
      finish,
      expanded: !!it.expanded && !!cat.expandable,
      ...(typeof it.frontStyle === 'string' && it.frontStyle ? { frontStyle: it.frontStyle } : {}),
      ...(typeof it.frontFinish === 'string' && it.frontFinish ? { frontFinish: it.frontFinish } : {}),
      ...(typeof it.hardware === 'string' && it.hardware ? { hardware: it.hardware } : {}),
      ...(it.doorsOpen ? { doorsOpen: true } : {}),
      ...(cat.wallMounted && Number.isFinite(Number(it.mountHeightIn))
        ? { mountHeightIn: clampNum(Math.round(Number(it.mountHeightIn)), 18, maxMountH, cat.mountHeightIn || 54) }
        : {}),
    });
  }

  const hotlistIds = Array.isArray(raw.hotlistIds)
    ? Array.from(new Set(raw.hotlistIds.filter((id) => typeof id === 'string' && allCatalog[id])))
    : [];
  const hotlistOnly = !!raw.hotlistOnly;

  const retainedDeskId =
    raw.retainedDeskId === 'retained_white_desk' || items.some((i) => i.catalogId === 'retained_white_desk')
      ? 'retained_white_desk'
      : 'retained_wood_desk';

  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const settings = {
    units: s.units === 'metric' ? 'metric' : 'imperial',
    lightingMood: s.lightingMood === 'evening' ? 'evening' : 'day',
    wallMode: ['cutaway', 'up', 'down'].includes(s.wallMode) ? s.wallMode : 'cutaway',
    fisheyeMode: ['equidistant', 'panini', 'stereographic', 'rectilinear'].includes(s.fisheyeMode)
      ? s.fisheyeMode
      : 'equidistant',
    fisheyeFovDeg: clampNum(s.fisheyeFovDeg, 90, 180, 138),
    eyeVantage: ['doorway', 'nw', 'ne', 'se', 'center'].includes(s.eyeVantage) ? s.eyeVantage : 'doorway',
    eyeHeightIn: clampNum(s.eyeHeightIn, 24, 86, 61),
    showGrid: s.showGrid !== false,
    showClearances: s.showClearances !== false,
    showDimensions: s.showDimensions !== false,
    wallSnap: s.wallSnap !== false,
    closetOpen: s.closetOpen !== false,
    entryDoorOpen: s.entryDoorOpen !== false,
    cabinetDoorsOpen: !!s.cabinetDoorsOpen,
    budgetCap: clampNum(s.budgetCap, 0, 50000, 1200),
  };

  const config = {
    schema: CONFIG_SCHEMA,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Imported Layout',
    room,
    retainedDeskId,
    hotlistIds,
    hotlistOnly,
    items,
    ...(Object.keys(dynamicCatalog).length > 0 ? { dynamicCatalog } : {}),
    settings,
  };

  return { ok: true, isBackup: false, config, warnings };
}

export function loadAutoSavedConfig(allCatalog, defaultRoom) {
  try {
    const rawV5 = localStorage.getItem(AUTO_STATE_KEY);
    if (rawV5) {
      const parsed = JSON.parse(rawV5);
      const res = validateAndNormalizeConfig(parsed, allCatalog, defaultRoom);
      if (res.ok && !res.isBackup) return res.config;
    }
    // Seamless migration from legacy v4 autosave
    const rawV4 = localStorage.getItem(LEGACY_STATE_KEY);
    if (rawV4) {
      const parsed = JSON.parse(rawV4);
      const res = validateAndNormalizeConfig(parsed, allCatalog, defaultRoom);
      if (res.ok && !res.isBackup) return res.config;
    }
  } catch (_) {}
  return null;
}

export function persistAutoSavedConfig(config) {
  try {
    localStorage.setItem(AUTO_STATE_KEY, JSON.stringify(config));
  } catch (_) {}
  idbSet(AUTO_STATE_KEY, config);
}

export function loadSavedConfigsList(allCatalog, defaultRoom, layoutPresets) {
  try {
    const raw = localStorage.getItem(SAVED_CONFIGS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const cleaned = [];
        for (const entry of arr) {
          const res = validateAndNormalizeConfig(entry, allCatalog, defaultRoom);
          if (res.ok && !res.isBackup) {
            cleaned.push({
              id: typeof entry.id === 'string' && entry.id ? entry.id : `cfg_${cleaned.length + 1}`,
              ...res.config,
            });
          }
        }
        return cleaned;
      }
    }

    // Migrate legacy A/B/C quick slots if present
    const legacyRaw = localStorage.getItem(LEGACY_SLOTS_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && typeof legacy === 'object') {
        const migrated = [];
        for (const key of ['A', 'B', 'C']) {
          const sl = legacy[key];
          if (sl && Array.isArray(sl.items)) {
            const res = validateAndNormalizeConfig(
              { name: sl.label || `Layout ${key}`, room: defaultRoom, items: sl.items },
              allCatalog,
              defaultRoom
            );
            if (res.ok && !res.isBackup) {
              migrated.push({ id: `slot_${key}`, ...res.config });
            }
          }
        }
        if (migrated.length > 0) return migrated;
      }
    }
  } catch (_) {}

  // Default starter saved plans for immediate side-by-side comparison
  const mkStarter = (id, name, presetKey) => {
    const preset = layoutPresets[presetKey];
    if (!preset) return null;
    const res = validateAndNormalizeConfig(
      { name, room: defaultRoom, items: preset.items },
      allCatalog,
      defaultRoom
    );
    return res.ok ? { id, ...res.config } : null;
  };
  return [
    mkStarter('slot_A', 'Layout A · Dual Face-Off', 'dual_parallel'),
    mkStarter('slot_B', 'Layout B · Tandem West', 'dual_tandem_west'),
  ].filter(Boolean);
}

export function persistSavedConfigsList(list) {
  try {
    localStorage.setItem(SAVED_CONFIGS_KEY, JSON.stringify(list));
  } catch (_) {}
  idbSet(SAVED_CONFIGS_KEY, list);
}

export function buildBackupBundle(currentConfig, savedConfigs) {
  return {
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    current: currentConfig,
    savedConfigs: savedConfigs || [],
  };
}

export function downloadJsonFile(dataObj, filename) {
  const json = JSON.stringify(dataObj, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatSavedTimestamp(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (_) {
    return '';
  }
}

export function slugifyFilename(name) {
  const base = String(name || 'room-config')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return `${base || 'room-config'}.json`;
}

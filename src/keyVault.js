// Safe Browser Key Vault for AI Layout Planner BYOK Credentials
// - Encrypts API keys at rest with Web Crypto AES-GCM-256 using a non-extractable CryptoKey
//   stored in IndexedDB (never writes plaintext key to localStorage when Web Crypto is available).
// - Mirrors encrypted payload in both IndexedDB + localStorage for cross-session reliability.
// - Gracefully falls back to isolated IDB + localStorage on non-secure file:// contexts.
// - Strictly isolated from room configuration exports (.json downloads / backups / clipboard).

const VAULT_DB_NAME = 'room_studio_key_vault_db';
const VAULT_DB_VERSION = 1;
const KEY_STORE = 'crypto_keys';
const DATA_STORE = 'vault_data';
const MASTER_KEY_ID = 'agent_aes_gcm_v2';

const PREFS_KEY = 'room_studio_llm_prefs_v2';
const VAULT_LS_KEY = 'room_studio_key_vault_v2';
const LEGACY_CFG_KEY = 'room_planner_llm_cfg';

export const DEFAULT_AGENT_SETTINGS = {
  mode: 'builtin',
  provider: 'gemini-4-neon',
  apiKey: '',
  model: '',
  thinkingLevel: 'MEDIUM',
  endpoint: '',
};

const VALID_PROVIDERS = new Set([
  'gemini-4-neon',
  'gemini-4-carbon',
  'gemini-4-hydrogen',
  'openai',
  'custom',
]);

function openVaultDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
        if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

function idbGet(db, storeName, key) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

function idbSet(db, storeName, key, value) {
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

function idbDelete(db, storeName, key) {
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function canUseWebCrypto() {
  return typeof window !== 'undefined' && !!(window.crypto && window.crypto.subtle);
}

async function getOrCreateMasterKey(db) {
  if (!db || !canUseWebCrypto()) return null;
  const existing = await idbGet(db, KEY_STORE, MASTER_KEY_ID);
  if (existing) return existing;
  try {
    // Non-extractable AES-GCM-256 key stays opaque inside IndexedDB
    const key = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const stored = await idbSet(db, KEY_STORE, MASTER_KEY_ID, key);
    return stored ? key : null;
  } catch (_) {
    return null;
  }
}

async function encryptSecret(plaintext, db) {
  if (!plaintext) return null;
  const key = await getOrCreateMasterKey(db);
  if (key && canUseWebCrypto()) {
    try {
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plaintext);
      const cipherBuf = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
      return {
        v: 2,
        enc: 'aes-gcm-256',
        iv: bytesToBase64(iv),
        ct: bytesToBase64(new Uint8Array(cipherBuf)),
        savedAt: new Date().toISOString(),
      };
    } catch (_) {
      // Fall through to obfuscated local storage if Web Crypto fails
    }
  }
  // Fallback for non-secure file:// origins without crypto.subtle
  const bytes = new TextEncoder().encode(plaintext);
  const mask = 0x5a;
  const masked = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) masked[i] = bytes[i] ^ mask ^ ((i * 31) & 0xff);
  return {
    v: 2,
    enc: 'local-masked',
    ct: bytesToBase64(masked),
    savedAt: new Date().toISOString(),
  };
}

async function decryptSecret(envelope, db) {
  if (!envelope || typeof envelope !== 'object' || !envelope.ct) return '';
  if (envelope.enc === 'aes-gcm-256') {
    if (!db || !canUseWebCrypto() || !envelope.iv) return '';
    try {
      const key = await idbGet(db, KEY_STORE, MASTER_KEY_ID);
      if (!key) return '';
      const iv = base64ToBytes(envelope.iv);
      const ct = base64ToBytes(envelope.ct);
      const plainBuf = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(plainBuf);
    } catch (_) {
      return '';
    }
  }
  if (envelope.enc === 'local-masked') {
    try {
      const masked = base64ToBytes(envelope.ct);
      const mask = 0x5a;
      const plain = new Uint8Array(masked.length);
      for (let i = 0; i < masked.length; i++) plain[i] = masked[i] ^ mask ^ ((i * 31) & 0xff);
      return new TextDecoder().decode(plain);
    } catch (_) {
      return '';
    }
  }
  return '';
}

function normalizeProvider(raw) {
  if (raw === 'gemini') return 'gemini-4-neon';
  if (VALID_PROVIDERS.has(raw)) return raw;
  return 'gemini-4-neon';
}

export async function loadAgentSettings() {
  const db = await openVaultDB();
  let prefs = null;

  try {
    const rawPrefs = localStorage.getItem(PREFS_KEY);
    if (rawPrefs) prefs = JSON.parse(rawPrefs);
  } catch (_) {}
  if (!prefs && db) {
    prefs = await idbGet(db, DATA_STORE, PREFS_KEY);
  }

  let envelope = null;
  if (db) {
    envelope = await idbGet(db, DATA_STORE, VAULT_LS_KEY);
  }
  if (!envelope) {
    try {
      const rawEnv = localStorage.getItem(VAULT_LS_KEY);
      if (rawEnv) envelope = JSON.parse(rawEnv);
    } catch (_) {}
  }

  let apiKey = envelope ? await decryptSecret(envelope, db) : '';
  let storageMode = envelope
    ? envelope.enc === 'aes-gcm-256'
      ? 'encrypted'
      : 'local'
    : 'none';

  // Migrate any legacy v1 plaintext localStorage config cleanly into the v2 vault
  if (!prefs && !apiKey) {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_CFG_KEY) || 'null');
      if (legacy && typeof legacy === 'object') {
        prefs = {
          mode: legacy.mode === 'api' ? 'api' : 'builtin',
          provider: normalizeProvider(legacy.provider),
          model: typeof legacy.model === 'string' && legacy.model !== 'gemini-2.5-flash' ? legacy.model : '',
          thinkingLevel: 'MEDIUM',
          endpoint: typeof legacy.endpoint === 'string' ? legacy.endpoint : '',
        };
        if (typeof legacy.apiKey === 'string' && legacy.apiKey.trim()) {
          apiKey = legacy.apiKey.trim();
        }
        // Persist migrated state safely and wipe legacy plaintext key
        const migrated = { ...DEFAULT_AGENT_SETTINGS, ...prefs, apiKey };
        const res = await saveAgentSettings(migrated);
        storageMode = res.storageMode;
        localStorage.removeItem(LEGACY_CFG_KEY);
      }
    } catch (_) {}
  }

  const settings = {
    ...DEFAULT_AGENT_SETTINGS,
    ...(prefs || {}),
    provider: normalizeProvider(prefs?.provider),
    apiKey,
  };

  return {
    settings,
    storageMode,
    hasCrypto: canUseWebCrypto(),
    hasIDB: !!db,
  };
}

export async function saveAgentSettings(cfg) {
  const db = await openVaultDB();
  const prefs = {
    mode: cfg.mode === 'api' ? 'api' : 'builtin',
    provider: normalizeProvider(cfg.provider),
    model: String(cfg.model || '').trim(),
    thinkingLevel: ['LOW', 'MEDIUM', 'HIGH'].includes(cfg.thinkingLevel) ? cfg.thinkingLevel : 'MEDIUM',
    endpoint: String(cfg.endpoint || '').trim(),
  };

  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (_) {}
  if (db) await idbSet(db, DATA_STORE, PREFS_KEY, prefs);

  const trimmedKey = String(cfg.apiKey || '').trim();
  if (!trimmedKey) {
    try {
      localStorage.removeItem(VAULT_LS_KEY);
    } catch (_) {}
    if (db) await idbDelete(db, DATA_STORE, VAULT_LS_KEY);
    return { ok: true, storageMode: 'none' };
  }

  const envelope = await encryptSecret(trimmedKey, db);
  let lsSaved = false;
  let idbSaved = false;
  try {
    localStorage.setItem(VAULT_LS_KEY, JSON.stringify(envelope));
    lsSaved = true;
  } catch (_) {}
  if (db) {
    idbSaved = await idbSet(db, DATA_STORE, VAULT_LS_KEY, envelope);
  }

  const storageMode =
    !lsSaved && !idbSaved
      ? 'memory'
      : envelope.enc === 'aes-gcm-256'
        ? 'encrypted'
        : 'local';

  return { ok: lsSaved || idbSaved, storageMode, lsSaved, idbSaved };
}

export async function clearStoredApiKey(currentCfg) {
  const next = { ...currentCfg, apiKey: '', mode: 'builtin' };
  await saveAgentSettings(next);
  return next;
}

// Zero-token-cost metadata check against Gemini API using x-goog-api-key header
export async function testGeminiApiKey(apiKey, modelId = 'gemini-4-neon') {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'Enter a Gemini API key first.' };
  const m = String(modelId || 'gemini-4-neon').trim();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
    });
    if (res.ok) {
      const info = await res.json();
      return {
        ok: true,
        displayName: info?.displayName || m,
        modelId: m,
      };
    }
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error?.message) detail = body.error.message;
    } catch (_) {}
    return { ok: false, error: detail };
  } catch (err) {
    return { ok: false, error: err?.message || 'Network request blocked or offline.' };
  }
}

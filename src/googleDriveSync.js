// Pure-Google OAuth 2.0 + Hidden Google Drive appDataFolder Cloud Sync
// - Zero backend required (runs 100% client-side on static GitHub Pages HTTPS)
// - Stores per-user room configurations & saved plans in hidden Drive appDataFolder
// - STRICTLY EXCLUDES Gemini / LLM API keys (API keys remain local-only in keyVault.js)

// Optional: paste your public Google OAuth 2.0 Web Client ID here to pre-configure for all browsers
// (Google OAuth Web Client IDs are public identifiers, safe to commit; Authorized JS Origin: https://kridsdale.github.io)
export const DEFAULT_GOOGLE_CLIENT_ID = '313084776444-edd8jtlfl8jgbj2g0kth48mufe91v92a.apps.googleusercontent.com';

const CLIENT_ID_STORAGE_KEY = 'room_studio_google_client_id_v1';
const USER_HINT_STORAGE_KEY = 'room_studio_google_user_hint_v1';
const CLOUD_FILE_NAME = 'room-studio-3d-cloud-v2.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email profile';

const FORBIDDEN_CLOUD_KEYS = new Set([
  'apiKey',
  'apikey',
  'api_key',
  'keyVault',
  'llmCfg',
  'llmConfig',
  'accessToken',
  'access_token',
  'token',
  'secret',
  'password',
]);

let gsiLoadPromise = null;

export function getGoogleClientId() {
  try {
    const saved = (localStorage.getItem(CLIENT_ID_STORAGE_KEY) || '').trim();
    if (saved) return saved;
  } catch (_) {}
  return DEFAULT_GOOGLE_CLIENT_ID.trim();
}

export function setGoogleClientId(clientId) {
  const clean = String(clientId || '').trim();
  try {
    if (clean) localStorage.setItem(CLIENT_ID_STORAGE_KEY, clean);
    else localStorage.removeItem(CLIENT_ID_STORAGE_KEY);
  } catch (_) {}
  return clean;
}

export function loadGoogleUserHint() {
  try {
    const raw = localStorage.getItem(USER_HINT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function saveGoogleUserHint(user) {
  try {
    if (user && user.email) {
      localStorage.setItem(
        USER_HINT_STORAGE_KEY,
        JSON.stringify({ email: user.email, name: user.name || '', picture: user.picture || '' })
      );
    } else {
      localStorage.removeItem(USER_HINT_STORAGE_KEY);
    }
  } catch (_) {}
}

// Recursively strip any credential/API-key field so secrets NEVER leave the browser
export function sanitizeBundleForCloud(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeBundleForCloud);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_CLOUD_KEYS.has(k)) continue;
    out[k] = sanitizeBundleForCloud(v);
  }
  return out;
}

function loadGoogleIdentityScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser environment required.'));
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  if (gsiLoadPromise) return gsiLoadPromise;

  gsiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve(window.google);
      else reject(new Error('Google Identity Services loaded without OAuth2 client.'));
    };
    script.onerror = () => {
      gsiLoadPromise = null;
      reject(new Error('Could not load Google Identity Services (offline or blocked).'));
    };
    document.head.appendChild(script);
  });
  return gsiLoadPromise;
}

async function fetchGoogleUserProfile(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sub: data.sub || '',
      email: data.email || '',
      name: data.name || data.email || 'Google Account',
      picture: data.picture || '',
    };
  } catch (_) {
    return null;
  }
}

export async function signInWithGoogleDrive(opts = {}) {
  const clientId = (opts.clientId || getGoogleClientId()).trim();
  if (!clientId) {
    throw new Error('Enter your Google OAuth Web Client ID first.');
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error('Google OAuth Client ID should end with ".apps.googleusercontent.com".');
  }

  const g = await loadGoogleIdentityScript();
  const tokenResp = await new Promise((resolve, reject) => {
    const tokenClient = g.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (!resp || resp.error) {
          reject(new Error(resp?.error_description || resp?.error || 'Google Sign-In canceled.'));
          return;
        }
        resolve(resp);
      },
      error_callback: (err) => {
        reject(new Error(err?.message || err?.type || 'Google Sign-In popup closed or blocked.'));
      },
    });
    tokenClient.requestAccessToken({ prompt: opts.prompt ?? '' });
  });

  const accessToken = tokenResp.access_token;
  const expiresIn = Number(tokenResp.expires_in) || 3500;
  const expiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
  const user = (await fetchGoogleUserProfile(accessToken)) || {
    email: 'Signed in with Google',
    name: 'Google User',
    picture: '',
  };
  saveGoogleUserHint(user);

  return { accessToken, expiresAt, user };
}

export function signOutGoogleDrive(accessToken) {
  saveGoogleUserHint(null);
  if (accessToken && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    } catch (_) {}
  }
}

async function findCloudFile(accessToken) {
  const q = encodeURIComponent(`name='${CLOUD_FILE_NAME}' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&pageSize=5`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    let msg = `Drive API HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg = err.error.message;
    } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  return Array.isArray(data.files) && data.files.length > 0 ? data.files[0] : null;
}

export async function pullFromGoogleDrive(accessToken) {
  const file = await findCloudFile(accessToken);
  if (!file) {
    return { exists: false, fileId: null, modifiedTime: null, bundle: null };
  }
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Drive download failed (HTTP ${res.status})`);
  }
  const bundle = await res.json();
  return {
    exists: true,
    fileId: file.id,
    modifiedTime: file.modifiedTime || null,
    bundle,
  };
}

export async function pushToGoogleDrive(accessToken, rawBundle, knownFileId = null) {
  const safeBundle = sanitizeBundleForCloud({
    ...rawBundle,
    cloudSyncedAt: new Date().toISOString(),
  });
  const jsonBody = JSON.stringify(safeBundle);

  let fileId = knownFileId;
  if (!fileId) {
    const existing = await findCloudFile(accessToken);
    if (existing) fileId = existing.id;
  }

  if (fileId) {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: jsonBody,
    });
    if (!res.ok) {
      throw new Error(`Drive update failed (HTTP ${res.status})`);
    }
    const updated = await res.json();
    return { ok: true, fileId: updated.id || fileId, modifiedTime: updated.modifiedTime || new Date().toISOString() };
  }

  // Create new hidden file inside Drive appDataFolder via multipart upload
  const boundary = 'room_studio_drive_boundary_' + Math.random().toString(36).slice(2, 10);
  const metadata = JSON.stringify({
    name: CLOUD_FILE_NAME,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  });
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${jsonBody}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );
  if (!res.ok) {
    let msg = `Drive create failed (HTTP ${res.status})`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg = err.error.message;
    } catch (_) {}
    throw new Error(msg);
  }
  const created = await res.json();
  return { ok: true, fileId: created.id, modifiedTime: created.modifiedTime || new Date().toISOString() };
}

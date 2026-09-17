// lib/transport.js — BYOK key store + the two transports (proxy | direct).
//
// BYOK, with teeth:
//   - The key is typed by a human into the page. It is never logged, never
//     put in a URL, never baked into a build, never written to a file, and
//     never included in the exported run.
//   - It can be parked in localStorage ONLY if the user ticks "remember".
//   - The module is DOM-free so the suite can exercise it under Node.
//
// Transports:
//   proxy (default)  POST <BASE>api/jev with the key in `x-jev-key`.
//                    Same-origin shim; the server never stores the key.
//   direct           POST https://api.typesafe.ai/v1/systemone with
//                    `Authorization: Bearer <key>`. Today the TypeSafe API
//                    sends NO Access-Control-Allow-Origin for any origin, so
//                    browsers are CORS-blocked. We keep it so the failure is
//                    explicit and a future allowlisted origin can use it.

export const KEY_STORAGE = 'jev.key';
export const TRANSPORT_STORAGE = 'jev.transport';
export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';

/**
 * Base-path awareness: the app must run both at `/` and under a hub subpath
 * like `/abhimanyu/`. Given location.pathname, strip a trailing
 * `index.html` and return the directory (always ending in '/'). All
 * root-absolute URL building prefixes with this; nginx strips the prefix.
 */
export function deriveBase(pathname = '') {
  let p = pathname || '';
  const idx = p.toLowerCase().lastIndexOf('index.html');
  if (idx >= 0) p = p.slice(0, idx);
  if (p.endsWith('/')) return p;
  const slash = p.lastIndexOf('/');
  return slash >= 0 ? p.slice(0, slash + 1) : '/';
}

const CORS_HINT =
  'CORS block (or network failure): api.typesafe.ai sends no Access-Control-Allow-Origin, so a browser cannot call it directly today. ' +
  'Switch to the proxy transport.';

/** memory fallback so the module works in tests without localStorage */
export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

export function loadSavedKey(storage) {
  try {
    return storage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function rememberKey(storage, key) {
  try {
    storage.setItem(KEY_STORAGE, key.trim());
  } catch { /* localStorage unavailable — remember silently off */ }
}

export function forgetKey(storage) {
  try {
    storage.removeItem(KEY_STORAGE);
  } catch { /* ignore */ }
}

export function loadTransportChoice(storage) {
  try {
    return storage.getItem(TRANSPORT_STORAGE) === 'direct' ? 'direct' : 'proxy';
  } catch {
    return 'proxy';
  }
}

export function rememberTransportChoice(storage, mode) {
  try {
    storage.setItem(TRANSPORT_STORAGE, mode === 'direct' ? 'direct' : 'proxy');
  } catch { /* ignore */ }
}

/**
 * Build a transport object. `storage` defaults to a memory store; in the
 * browser app.js passes window.localStorage. `fetchImpl` lets tests point
 * at a mock server. `base` is the derived BASE ('' at root, '/abhimanyu/').
 *
 * Returns { mode, setMode, ask, snapshot }.
 */
export function createTransport({ base = '', storage, fetchImpl = fetch } = {}) {
  const store = storage || memoryStorage();
  let mode = loadTransportChoice(store);

  function setMode(next) {
    mode = next === 'direct' ? 'direct' : 'proxy';
    rememberTransportChoice(store, mode);
  }

  function url() {
    if (mode === 'direct') return UPSTREAM;
    const slash = base && !base.endsWith('/') ? '/' : '';
    return `${base}${slash}api/jev`;
  }

  function headers(key) {
    if (mode === 'direct') {
      return {
        'content-type': 'application/json',
        authorization: key ? `Bearer ${key}` : 'Bearer missing',
      };
    }
    const h = { 'content-type': 'application/json' };
    if (key) h['x-jev-key'] = key;
    return h;
  }

  /**
   * One call. Returns { ok, status, body, error } — never throws.
   *   ok    true when the shim/upstream answered 2xx
   *   body  parsed JSON (answer or { error: {...} })
   *   error detailed failure object when ok is false
   */
  async function ask({ state, questions, model = 'jev-latest', key = '' }) {
    let resp;
    try {
      resp = await fetchImpl(url(), {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ state, questions, model }),
      });
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: {
          code: 'network',
          message: mode === 'direct' ? `${CORS_HINT} (${e?.message || 'failed to fetch'})` : `network error: ${e?.message || 'failed to fetch'}`,
          direct: mode === 'direct',
        },
      };
    }
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    if (!resp.ok) {
      const err = (body && body.error) || { code: `http_${resp.status}`, message: `request failed (HTTP ${resp.status})` };
      if (mode === 'direct') err.direct = true;
      return { ok: false, status: resp.status, body, error: err };
    }
    return { ok: true, status: resp.status, body };
  }

  return {
    get mode() { return mode; },
    setMode,
    ask,
    url,
  };
}
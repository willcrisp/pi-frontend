// localStorage helpers that never throw.
//
// Every store persists something (connection settings, hidden models, archived
// projects, branch and file-list caches, the last model per session), and each
// one had grown its own try/catch — or skipped it. Both failure modes are real:
// Safari private mode throws on setItem, and a half-written or hand-edited value
// throws on JSON.parse. A persisted preference is never worth taking the app
// down for, so these swallow and fall back.
//
// Keys are namespaced by their owning module; grep the key to find who owns it.

export function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — the value just won't persist */
  }
}

// A stored JSON array, guaranteed to come back as an array.
export function readArray(key) {
  const value = readJSON(key, []);
  return Array.isArray(value) ? value : [];
}

export function readString(key, fallback = "") {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export function writeString(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* see writeJSON */
  }
}

// A stored number, falling back when absent or unparseable. Callers that clamp
// to a range should still do so — this only guarantees you get a finite number.
export function readNumber(key, fallback) {
  const raw = Number(readString(key, ""));
  return Number.isFinite(raw) && raw !== 0 ? raw : fallback;
}

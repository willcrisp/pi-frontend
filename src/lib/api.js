// The only correct way to reach the OpenCode V2 server.
//
// Every request has to be built from two things in stores/ssh.js:
//   apiBase()     — `/api/<port>/api`, the dev proxy's port prefix plus the
//                   server's own `/api`. A hardcoded `/api/...` reaches nothing.
//   authHeaders() — Basic auth. The OpenAPI declares `security: []` on every
//                   operation and the server 401s anyway.
// Both failures are invisible until runtime, and both have shipped before. So
// call the helpers here instead of `fetch` — path arguments are server-relative
// ("/session/abc/message") and the prefix and headers are applied for you.
//
// Two layers, pick by how much the caller cares about failure:
//   apiGet/apiPost/apiDelete → the raw Response. Yours to check `.ok` on, for
//     callers that report distinct messages per status.
//   getJSON/postJSON         → parsed body, or null on any failure (non-2xx,
//     network error, unparseable body). For callers where "couldn't" and
//     "empty" are the same outcome.
//
// `unwrap()` handles the list envelope: V2 list routes answer `{ data: [...] }`.
import { apiBase, authHeaders } from "../stores/ssh.js";

// Server-relative path -> fully prefixed URL. Leading slash optional.
export function apiUrl(path) {
  return `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiGet(path, init = {}) {
  return fetch(apiUrl(path), { ...init, headers: { ...authHeaders(), ...init.headers } });
}

// POST with a JSON body. Pass no body for the routes that take none
// (interrupt, compact) — they get no Content-Type either.
export function apiPost(path, body, init = {}) {
  return fetch(apiUrl(path), {
    ...init,
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...authHeaders(),
      ...init.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function apiDelete(path, init = {}) {
  return fetch(apiUrl(path), {
    ...init,
    method: "DELETE",
    headers: { ...authHeaders(), ...init.headers },
  });
}

// GET returning the parsed body, or null if anything went wrong. Used where a
// missing answer is survivable — e.g. a sub-agent whose session has been pruned
// server-side must not break the whole transcript load.
export async function getJSON(path) {
  try {
    const res = await apiGet(path);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// POST returning the parsed body, or null if anything went wrong.
export async function postJSON(path, body) {
  try {
    const res = await apiPost(path, body);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// The server's own complaint from an error response, falling back to a status
// line. Consumes the body, so only call it on a response you are done with.
export async function errorMessage(res, fallback) {
  try {
    const payload = await res.json();
    if (payload && payload.message) return payload.message;
  } catch {
    /* non-JSON error body — the status line is enough */
  }
  return fallback;
}

// Unwrap the V2 `{ data: [...] }` list envelope (tolerates a bare array too).
export function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

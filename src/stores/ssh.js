// OpenCode V2 Connection Store
import { reactive } from "vue";
import { readNumber, readString, writeString } from "../lib/storage.js";

const PORT_KEY = "opencode-web:port";
const HOST_KEY = "opencode-web:host";
const SECURE_KEY = "opencode-web:secure";
const MODE_KEY = "opencode-web:mode";
const USERNAME_KEY = "opencode-web:username";
const PASSWORD_KEY = "opencode-web:password";

export const connectionStore = reactive({
  // Where the opencode2 server is. `host` is new for the mobile build: on the
  // desktop the server is always reached through an ssh tunnel to localhost, but
  // a phone has no tunnel and dials the machine directly (a LAN or Tailscale
  // address). It stays "127.0.0.1" for the desktop app, which keeps that build's
  // behaviour identical.
  host: readString(HOST_KEY, "127.0.0.1"),
  port: readNumber(PORT_KEY, 4096),
  // Whether the server is reached over TLS. False for the tunnelled desktop
  // workflow and a LAN address; true for a Coder port-forward URL, which is
  // https on 443 with the port encoded in the hostname.
  secure: readString(SECURE_KEY, "") === "1",
  mode: readString(MODE_KEY, "local"), // "local" | "remote"
  status: "unknown", // "unknown" | "connecting" | "connected" | "failed"
  testing: false,
  testResult: null, // { ok, message } | null
  error: "",
  username: readString(USERNAME_KEY, "opencode"),
  password: readString(PASSWORD_KEY, ""),
});

// Proxy routing prefix + the opencode2 server's own `/api` route prefix. The
// forwarded path becomes `/api/...` on the server.
//
// The prefix encodes the whole upstream address — `/api/<scheme>/<host>:<port>`
// — rather than just the port, and that is deliberate: it means the proxy is
// stateless and needs no configuration channel of its own. The web build's Vite proxy
// (vite.config.js) and the Android build's in-app proxy (LocalProxy.java) both
// read the target straight off the URL, so the JS never has to tell either one
// where to connect.
//
// Why a proxy at all on a native build, where you might expect a plain absolute
// URL: the opencode2 server sends no CORS headers on any route and 404s the
// OPTIONS preflight (verified against a live server), so a WebView can never
// call it cross-origin. Serving the app from a proxy that also forwards /api
// makes every request same-origin, which additionally keeps SSE streaming and
// keeps the PTY connect-token's same-origin check satisfied.
export function apiBase() {
  return `/api/${connectionStore.secure ? "https" : "http"}/${connectionStore.host}:${connectionStore.port}/api`;
}

// UTF-8-safe base64 basic-auth header; empty when no password (server has no auth).
function buildAuthHeaders(username, password) {
  if (!password) return {};
  const token = btoa(unescape(encodeURIComponent(`${username || "opencode"}:${password}`)));
  return { Authorization: `Basic ${token}` };
}

export function authHeaders() {
  return buildAuthHeaders(connectionStore.username, connectionStore.password);
}

export function setCredentials(username, password) {
  connectionStore.username = username || "opencode";
  connectionStore.password = password || "";
  writeString(USERNAME_KEY, connectionStore.username);
  writeString(PASSWORD_KEY, connectionStore.password);
}

// Probe a target BEFORE committing to it — the connect dialog calls this with a
// port and credentials the user has typed but not saved. That is why it builds
// the URL and headers by hand instead of going through lib/api.js: apiBase() and
// authHeaders() read the *current* connection, which is precisely not what is
// being tested here.
export async function testConnection(port, username, password, host, secure) {
  connectionStore.testing = true;
  connectionStore.testResult = null;
  const u = username !== undefined ? username : connectionStore.username;
  const p = password !== undefined ? password : connectionStore.password;
  const h = host !== undefined && host !== "" ? host : connectionStore.host;
  const scheme = (secure !== undefined ? secure : connectionStore.secure) ? "https" : "http";
  try {
    const res = await fetch(`/api/${scheme}/${h}:${port}/api/health`, {
      headers: buildAuthHeaders(u, p),
    });
    if (res.ok) {
      connectionStore.testResult = { ok: true, message: "Connected to OpenCode V2!" };
      return true;
    }
    if (res.status === 401) {
      connectionStore.testResult = { ok: false, message: "Authentication failed — check username/password" };
      return false;
    }
    connectionStore.testResult = { ok: false, message: `Server returned ${res.status}` };
    return false;
  } catch (err) {
    connectionStore.testResult = { ok: false, message: err.message || "Failed to reach server" };
    return false;
  } finally {
    connectionStore.testing = false;
  }
}

export function setConnection(port, mode, host, secure) {
  connectionStore.port = Number(port) || 4096;
  if (mode) connectionStore.mode = mode;
  if (host !== undefined) {
    connectionStore.host = String(host || "").trim() || "127.0.0.1";
    writeString(HOST_KEY, connectionStore.host);
  }
  if (secure !== undefined) {
    connectionStore.secure = !!secure;
    writeString(SECURE_KEY, connectionStore.secure ? "1" : "0");
  }
  writeString(PORT_KEY, connectionStore.port);
  writeString(MODE_KEY, connectionStore.mode);
}

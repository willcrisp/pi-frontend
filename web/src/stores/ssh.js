// OpenCode V2 Connection Store
import { reactive } from "vue";

const PORT_KEY = "opencode-web:port";
const MODE_KEY = "opencode-web:mode";
const USERNAME_KEY = "opencode-web:username";
const PASSWORD_KEY = "opencode-web:password";

export const connectionStore = reactive({
  port: Number(localStorage.getItem(PORT_KEY)) || 4096,
  mode: localStorage.getItem(MODE_KEY) || "local", // "local" | "remote"
  status: "unknown", // "unknown" | "connecting" | "connected" | "failed"
  testing: false,
  testResult: null, // { ok, message } | null
  error: "",
  username: localStorage.getItem(USERNAME_KEY) || "opencode",
  password: localStorage.getItem(PASSWORD_KEY) || "",
});

export function apiBase() {
  // Proxy routing prefix `/api/<port>` (stripped by the Vite dev proxy) + the opencode2
  // server's own `/api` route prefix. Forwarded path becomes `/api/...` on the server.
  return `/api/${connectionStore.port}/api`;
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
  localStorage.setItem(USERNAME_KEY, connectionStore.username);
  localStorage.setItem(PASSWORD_KEY, connectionStore.password);
}

export async function testConnection(port, username, password) {
  connectionStore.testing = true;
  connectionStore.testResult = null;
  const u = username !== undefined ? username : connectionStore.username;
  const p = password !== undefined ? password : connectionStore.password;
  try {
    const res = await fetch(`/api/${port}/api/health`, { headers: buildAuthHeaders(u, p) });
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

export function setConnection(port, mode) {
  connectionStore.port = Number(port) || 4096;
  if (mode) connectionStore.mode = mode;
  localStorage.setItem(PORT_KEY, String(connectionStore.port));
  localStorage.setItem(MODE_KEY, connectionStore.mode);
}

// --- Back-compat aliases for SshPopover.vue (Phase B rewires it and drops these) ---
export const sshStore = connectionStore; // alias (targetUrl no longer used)
export const testTargetUrl = (url) => testConnection(url); // legacy shim
export const setTargetUrl = (url) => setConnection(url);

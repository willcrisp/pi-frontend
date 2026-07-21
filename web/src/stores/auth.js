// Client for the provider-connect flow, mirroring pi's interactive `/login`.
//
// pi's per-project RPC protocol (pi.js) has no login command — credential and
// OAuth orchestration is app-owned and lives in pi's ModelRuntime. So the
// server exposes a separate `/ws-auth` socket that bridges to a headless
// login helper (server/pi-login/login-helper.mjs) which drives that same
// ModelRuntime.login() the TUI uses. This module speaks that helper's
// newline-delimited JSON protocol and exposes a reactive `authStore` for
// ConnectDialog.vue.
//
// Key exports:
//   authStore                    — {open, connected, providers, prompt, notices, activeProvider, toast, error, busy}
//   openConnect()/closeConnect()  — open the dialog (connects the /ws-auth socket) / tear it down
//   startLogin(providerId, method) / logout(providerId) — drive one provider's login/logout flow
//   respondPrompt(value)/cancelLogin() — answer or abort the current login step
import { reactive } from "vue";

export const authStore = reactive({
  open: false,
  connected: false, // WS to the login helper is up
  loading: false, // waiting on the initial provider list
  providers: [], // [{ id, name, oauth, apiKey, apiKeyManual, status }]
  busy: false, // a login/logout is in flight
  activeProvider: null, // { id, name, method } currently connecting
  prompt: null, // pending input step: { id, type, message, placeholder, options }
  notices: [], // auth_url / device_code / info / progress events for the active flow
  error: null, // transport/helper error banner
  toast: null, // transient success/failure message
});

let ws = null;

export function openConnect() {
  authStore.open = true;
  authStore.error = null;
  authStore.toast = null;
  connect();
}

export function closeConnect() {
  authStore.open = false;
  authStore.prompt = null;
  authStore.activeProvider = null;
  authStore.notices = [];
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  authStore.connected = false;
}

function connect() {
  if (ws) return;
  authStore.loading = true;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws-auth`);
  ws.onopen = () => {
    authStore.connected = true;
    send({ type: "list" });
  };
  ws.onclose = () => {
    authStore.connected = false;
    authStore.loading = false;
    ws = null;
  };
  ws.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(ev);
  };
}

function send(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

function handle(ev) {
  switch (ev.type) {
    case "ready":
      break;
    case "providers":
      authStore.providers = ev.providers || [];
      authStore.loading = false;
      break;
    case "prompt":
      // A single input step in the active login flow (secret/text/select/manual_code).
      authStore.prompt = { id: ev.id, ...ev.prompt };
      break;
    case "notify":
      // Non-blocking status: OAuth URL, device code, progress text.
      authStore.notices.push(ev.event);
      break;
    case "login_result":
      authStore.busy = false;
      authStore.prompt = null;
      authStore.activeProvider = null;
      authStore.notices = [];
      authStore.toast = ev.ok
        ? { ok: true, message: `Connected ${providerName(ev.providerId)}` }
        : { ok: false, message: ev.error || `Failed to connect ${providerName(ev.providerId)}` };
      break;
    case "logout_result":
      authStore.busy = false;
      authStore.toast = ev.ok
        ? { ok: true, message: `Disconnected ${providerName(ev.providerId)}` }
        : { ok: false, message: ev.error || "Failed to disconnect" };
      break;
    case "error":
      authStore.error = ev.message;
      authStore.busy = false;
      authStore.loading = false;
      break;
  }
}

function providerName(id) {
  return authStore.providers.find((p) => p.id === id)?.name || id;
}

export function startLogin(providerId, method) {
  const p = authStore.providers.find((x) => x.id === providerId);
  authStore.busy = true;
  authStore.error = null;
  authStore.notices = [];
  authStore.prompt = null;
  authStore.activeProvider = { id: providerId, name: p?.name || providerId, method };
  send({ type: "login", providerId, method });
}

export function logout(providerId) {
  authStore.busy = true;
  authStore.error = null;
  send({ type: "logout", providerId });
}

// value === null cancels the current step (and, via the helper, the login).
export function respondPrompt(value) {
  const id = authStore.prompt?.id;
  authStore.prompt = null;
  send({ type: "prompt_response", id, value });
}

export function cancelLogin() {
  send({ type: "cancel" });
  authStore.busy = false;
  authStore.prompt = null;
  authStore.activeProvider = null;
  authStore.notices = [];
}

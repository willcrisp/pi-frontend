// The SSE subscription and app-level init.
//
// fetch-based rather than the browser's native EventSource, because EventSource
// cannot carry an Authorization header and the server requires one.
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { opencodeStore } from "./state.js";
import { apiUrl, apiGet } from "../../lib/api.js";
import { authHeaders } from "../ssh.js";
import { handleServerEvent } from "./events.js";
import { loadCatalogs } from "./catalog.js";
import { loadMcpServers } from "../mcp.js";
import { reconcileRunState, resetRunProbe } from "./run.js";
import { loadPendingQuestions } from "../question.js";
import { loadPendingPermissions } from "../permission.js";

let eventAbort = null;

function teardownEventStream() {
  if (eventAbort) {
    eventAbort.abort();
    eventAbort = null;
  }
}

function setupEventStream() {
  if (eventAbort) return;
  eventAbort = new AbortController();

  fetchEventSource(apiUrl("/event"), {
    headers: authHeaders(),
    signal: eventAbort.signal,
    openWhenHidden: true,
    onopen: async (res) => {
      if (res.ok) {
        opencodeStore.connected = true;
        opencodeStore.error = null;
        loadPendingQuestions();
        loadPendingPermissions();
        resetRunProbe();
        reconcileRunState();
        loadCatalogs({ force: true });
        loadMcpServers();
        return;
      }
      opencodeStore.connected = false;
      if (res.status === 401) {
        opencodeStore.error = "Authentication failed — check username/password";
        const e = new Error("event stream 401");
        e.fatal = true;
        throw e;
      }
      throw new Error(`event stream error (${res.status})`);
    },
    onmessage: (ev) => {
      if (!ev.data) return;
      try {
        handleServerEvent(JSON.parse(ev.data));
      } catch (e) {
        console.error("Failed to parse SSE payload:", e);
      }
    },
    onerror: (err) => {
      opencodeStore.connected = false;
      if (err && err.fatal) {
        teardownEventStream();
        throw err;
      }
    },
  }).catch(() => {
    teardownEventStream();
  });
}

export function reconnectStream() {
  teardownEventStream();
  setupEventStream();
}

// Initialize connection & metadata from the opencode2 server.
export async function initOpenCode() {
  teardownEventStream();
  try {
    const res = await apiGet("/health");
    opencodeStore.connected = res.ok;
    if (!res.ok) {
      const status = res.status;
      opencodeStore.error =
        status === 401
          ? "Authentication failed — check username/password"
          : `Server returned ${status}`;
      return;
    }
  } catch (err) {
    opencodeStore.connected = false;
    opencodeStore.error = `Failed to reach opencode server at ${apiUrl("/health")}`;
    return;
  }

  await loadCatalogs({ force: true });
  // Not awaited: it only decides how a tool call is labelled, and the route is
  // absent on some builds. Nothing should wait on it to show the transcript.
  loadMcpServers();
  setupEventStream();
}

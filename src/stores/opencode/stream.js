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
import { reconcileRunState, resetRunProbe } from "./run.js";
import { loadPendingQuestions } from "../question.js";

let eventAbort = null;

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
        // All of these run on every (re)connect, not just the first, because
        // what the stream dropped while it was down is exactly what blocks the
        // UI afterwards: an ask nobody ever sees, and — since a turn's end is a
        // single event — a run that appears to go on forever.
        loadPendingQuestions();
        resetRunProbe();
        reconcileRunState();
        // A live stream is the strongest evidence available that the server is
        // up, which is exactly what a catalog that answered too early at boot
        // was waiting for. No-ops once all four have landed.
        loadCatalogs({ force: true });
        return;
      }
      opencodeStore.connected = false;
      if (res.status === 401) opencodeStore.error = "Authentication failed — check username/password";
      const e = new Error(`event stream failed (${res.status})`);
      e.fatal = true; // stop retrying on auth/other HTTP errors
      throw e;
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
      if (err && err.fatal) throw err; // fatal => stop; otherwise return => library retries w/ backoff
    },
  }).catch(() => {
    /* fatal stop already handled; swallow */
  });
}

// Initialize connection & metadata from the opencode2 server.
export async function initOpenCode() {
  try {
    const res = await apiGet("/health");
    opencodeStore.connected = res.ok;
  } catch (err) {
    opencodeStore.connected = false;
    opencodeStore.error = `Failed to reach opencode server at ${apiUrl("/health")}`;
  }

  // Not awaited past the first attempt: loadCatalogs owns its own retry backoff
  // (see catalog.js), and the stream must come up regardless — it is what
  // triggers the retry that recovers a server which was still starting.
  await loadCatalogs({ force: true });
  setupEventStream();
}

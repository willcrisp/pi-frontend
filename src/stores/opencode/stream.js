// The SSE subscription and app-level init.
//
// fetch-based rather than the browser's native EventSource, because EventSource
// cannot carry an Authorization header and the server requires one.
//
// ── Keeping the stream alive is this module's job ────────────────────────────
// Everything the UI knows during a turn arrives here, so a stream that has
// stopped delivering looks exactly like an agent that has stopped thinking: the
// reasoning block sits on its last delta and the composer keeps its stop square
// forever. Two ways that happens, and neither raises an error on its own:
//
//   · **A clean close.** `fetchEventSource` resolves — and stops — when the
//     response ends normally. Anything between us and the server can end it:
//     the dev proxy, an ssh tunnel, a load balancer trimming idle connections.
//     `onclose` below turns that back into a retry, which is the whole reason
//     it is here; without it one idle timeout ended the session's live updates.
//   · **A stall.** The socket stays open and nothing arrives — a laptop that
//     slept, a tunnel whose far end went away without a FIN. No error, no close,
//     no events, forever. Only a watchdog finds this one.
//
// The watchdog does not guess from silence alone: silence is normal during a
// long tool call. It fires only when the run poll in run.js is getting answers
// (so the server is reachable and working) while this stream has heard nothing —
// which is proof the fault is the stream's own. A reconnect then costs one
// request, and what was missed while it was down is picked up from the
// transcript, since the server does not replay events to a new subscriber.
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { opencodeStore } from "./state.js";
import { apiUrl, apiGet } from "../../lib/api.js";
import { authHeaders } from "../ssh.js";
import { handleServerEvent } from "./events.js";
import { loadAgents, loadCommands, loadModels, loadSkills } from "./catalog.js";
import { anyRunActive, lastRunProbeOkAt, reconcileRunState, resetRunProbe } from "./run.js";
import { refreshActiveMessages } from "./messages.js";
import { loadPendingQuestions } from "../question.js";

// How often the watchdog looks, and how long a run may go with nothing on the
// stream while the server is demonstrably answering elsewhere. Generous: a tool
// call can legitimately run this long without emitting anything, and the cost of
// being wrong is a reconnect.
const WATCHDOG_MS = 5000;
const STALL_MS = 20000;
// A run that has produced no event *at all* is a stronger signal than a quiet
// one, and gets a shorter fuse: the POST that started it was answered, so the
// server is up, and a healthy stream acknowledges an admitted prompt at once.
// This is the "I sent a message and it just spins" case — typically a stream
// that died while the tab was asleep and has not been asked for since.
const SILENT_START_MS = 8000;
// Reconnect backoff. The library retries every second by default, which turns a
// server that is down into a request per second for as long as the tab is open.
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

let eventAbort = null;
let lastEventAt = 0;
let connections = 0;
let backoffMs = MIN_BACKOFF_MS;
let watchdogTimer = null;

function setupEventStream() {
  if (eventAbort) return;
  eventAbort = new AbortController();
  const abort = eventAbort;

  fetchEventSource(apiUrl("/event"), {
    headers: authHeaders(),
    signal: abort.signal,
    openWhenHidden: true,
    onopen: async (res) => {
      if (res.ok) {
        const reconnected = connections++ > 0;
        opencodeStore.connected = true;
        lastEventAt = Date.now();
        backoffMs = MIN_BACKOFF_MS;
        // All of these run on every (re)connect, not just the first, because
        // what the stream dropped while it was down is exactly what blocks the
        // UI afterwards: an ask nobody ever sees, and — since a turn's end is a
        // single event — a run that appears to go on forever.
        loadPendingQuestions();
        resetRunProbe();
        reconcileRunState();
        // Events are not replayed to a new subscriber, so the gap is only
        // recoverable from the transcript. Merged rather than replaced: a
        // message still streaming when the stream died is on screen but not yet
        // in the server's list, and a plain replace would blank it.
        if (reconnected) refreshActiveMessages({ merge: true });
        return;
      }
      opencodeStore.connected = false;
      if (res.status === 401) opencodeStore.error = "Authentication failed — check username/password";
      const e = new Error(`event stream failed (${res.status})`);
      e.fatal = true; // stop retrying on auth/other HTTP errors
      throw e;
    },
    onmessage: (ev) => {
      // Before the empty-data check: a keepalive frame carries no data and is
      // still the stream proving it is alive, which is all the watchdog wants.
      lastEventAt = Date.now();
      if (!ev.data) return;
      try {
        handleServerEvent(JSON.parse(ev.data));
      } catch (e) {
        console.error("Failed to parse SSE payload:", e);
      }
    },
    // The response ended without an error. `fetchEventSource` treats that as
    // "done" and never reconnects, but nothing about a finished HTTP response
    // means the session is over — so throw, and let onerror schedule the retry.
    onclose: () => {
      opencodeStore.connected = false;
      throw new Error("event stream closed by server");
    },
    onerror: (err) => {
      opencodeStore.connected = false;
      if (err && err.fatal) throw err; // fatal => stop
      const wait = backoffMs; // returning a number sets the retry delay
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      return wait;
    },
  }).catch(() => {
    /* fatal stop already handled; swallow */
  });
}

// Drop the current subscription and open a new one. Aborting the signal makes
// the library dispose of the in-flight request without retrying, so this is the
// only way to replace a connection it still believes in.
function restartEventStream() {
  if (eventAbort) eventAbort.abort();
  eventAbort = null;
  opencodeStore.connected = false;
  backoffMs = MIN_BACKOFF_MS;
  setupEventStream();
}

// --- The stall watchdog ------------------------------------------------------

// When the earliest run still believed to be in flight was started.
function oldestRunStartedAt() {
  let at = 0;
  for (const rec of Object.values(opencodeStore.sessionActivity)) {
    if (rec.running && rec.startedAt && (!at || rec.startedAt < at)) at = rec.startedAt;
  }
  return at;
}

function checkStreamLiveness() {
  // Only mid-run: outside one, silence says nothing and a stale connection is
  // repaired by the next turn's first event either way.
  if (!anyRunActive()) return;
  const now = Date.now();
  const startedAt = oldestRunStartedAt();
  const neverAnswered = startedAt && lastEventAt < startedAt && now - startedAt > SILENT_START_MS;
  if (now - lastEventAt < STALL_MS && !neverAnswered) return;
  // The server has to be answering something else right now for this to be the
  // stream's fault. When the whole connection is down, the library's own retry
  // is the right mechanism and jumping in here would only fight it.
  if (now - lastRunProbeOkAt() > STALL_MS) return;
  console.warn(
    `No SSE traffic for ${Math.round((now - lastEventAt) / 1000)}s with a run in flight — reconnecting`
  );
  lastEventAt = now; // don't fire again until the new connection has had its chance
  // The transcript resync is the reconnect's own (onopen), so a connection that
  // comes back does it once and a connection that doesn't isn't asked twice.
  restartEventStream();
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(checkStreamLiveness, WATCHDOG_MS);
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

  await Promise.all([loadModels(), loadAgents(), loadCommands(), loadSkills()]);
  setupEventStream();
  startWatchdog();
}

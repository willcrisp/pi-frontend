// When a turn is over — and how we know.
//
// This is the module the composer's stop-vs-send square depends on, and the
// sidebar dot with it. It exists because **no event reliably says "the run
// finished"**, which is what left the square stuck on stop forever.
//
// Verified by running a real turn against a live `opencode2 serve`
// (0.0.0-next-202606270058) and tapping GET /api/event:
//
//   session.next.prompt.admitted -> session.next.prompted
//     -> session.next.step.started
//        -> reasoning.started/.delta/.ended, text.started/.delta/.ended, tool.*
//     -> session.next.step.ended {finish: "stop", cost, tokens}
//
// That is the whole turn. There is **no session.execution.* and no
// session.idle** in that build — the last event of a run is a `step.ended`
// carrying a `finish` reason. Other builds (the ALF-UAT target) do emit
// session.execution.succeeded. So "which event ends a run" is not answerable
// across builds, and picking one is how this broke.
//
// Worse, `step.ended` is *not* the end of the run when a prompt was steered in.
// Verified in the same session: steering mid-run gives
//
//   ... step.ended {finish: "stop"} -> session.next.prompted (the steered input)
//   -> step.started ... -> step.ended {finish: "stop"}
//
// — one agent loop, two steps. Settling on the first `step.ended` would flap the
// square stop→send→stop and fire a transcript refresh into the middle of the
// next step.
//
// So a terminal event is treated as a *candidate* and confirmed against server
// truth: **GET /api/session/active** answers with every session whose agent loop
// is running right now, and its own description says "sessions absent from the
// result are inactive":
//
//   {"data": {"ses_04ec…": {"type": "running"}}}   // running
//   {"data": {}}                                   // idle
//
// Live-verified: it reports the session for the whole of both steps above and
// goes empty the moment the loop drains. One cheap GET reconciles every session
// we track, so the same call is both
//
//   · the confirmation for a terminal event (no flapping, no early refresh), and
//   · a poll while anything is believed to be running — which is what recovers a
//     run whose terminal event never arrived at all, whether because the stream
//     dropped mid-turn or because the build spells it something we've never seen.
//
// A build without the route degrades to the old behaviour rather than hanging:
// once the server has answered "no such route" the poll gives up and terminal
// events are trusted on their own. A *transient* failure must never do that —
// see the probe section below.
import { watch } from "vue";
import { opencodeStore } from "./state.js";
import { apiGet } from "../../lib/api.js";
import { activityRecord, setUnread } from "./activity.js";
import { clearSteers } from "./steer.js";
import { refreshActiveMessages } from "./messages.js";

// How often to ask while a run is believed to be in flight. Nothing is polled
// while everything is idle.
const POLL_MS = 4000;
// A terminal event is confirmed, not obeyed. Also coalesces the burst at the end
// of a turn (step.ended + execution.succeeded + usage on some builds).
const CONFIRM_MS = 250;
// Consecutive *malformed* answers after which the route is treated as
// unusable on this server. A 200 that isn't the documented shape is a build
// mismatch, not a blip, so it is worth giving up on — unlike a network error.
const PROBE_GIVE_UP = 3;
// How long a run we started ourselves may be absent from GET /session/active
// before the emptiness is believed. The POST that starts it can still be in
// flight, and the server registers the loop when it admits the input, not when
// we decided to send — settling on that window takes the composer back to a
// send arrow and wipes the optimistic user message a moment before the run's
// first event lands. Once the server has acknowledged the run even once (a
// probe or any event for it), no grace is needed and this is not consulted.
const START_GRACE_MS = 15000;

// Every spelling of "the run stopped" seen or documented across builds. A
// `step.ended` is conditional (see isRunEndEvent), so it isn't in here.
const RUN_END_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.completed",
  "session.execution.failed",
  "session.execution.aborted",
  "session.execution.cancelled",
  "session.aborted",
  "session.error",
  "session.step.failed",
]);

// Does this event mean the run may have ended? Types are canonical (the
// `session.next.` infix is normalized away in events.js).
export function isRunEndEvent(type, props) {
  if (RUN_END_EVENTS.has(type)) return true;
  // A step ending is the end of the turn only when the model stopped, rather
  // than handing back tool calls for another step. `finish` is the AI-SDK finish
  // reason ("stop" | "tool-calls" | "length" | …); a build that doesn't send one
  // leaves this to its own lifecycle events.
  if (type === "session.step.ended") return !!props.finish && props.finish !== "tool-calls";
  return false;
}

// --- Settling ----------------------------------------------------------------

// Stop claiming a session's agent is mid-turn. Safe to call for any session:
// the streaming flag and the transcript belong to the one on screen, the dot
// belongs to all of them, and a sub-agent's card settles itself.
// `merge` is for a settle where the server may not yet hold everything on
// screen — the stop button, which lands before the interrupted step has been
// flushed. See refreshActiveMessages.
export function settleRun(sessionID, { merge = false } = {}) {
  if (!sessionID) return;
  const rec = activityRecord(sessionID);
  const wasRunning = rec.running;
  rec.running = false;
  rec.confirmed = false;
  rec.updatedAt = Date.now();
  // Anything admitted into a run that has stopped has either been promoted or
  // died with it — nothing is still waiting to be read.
  clearSteers(sessionID);

  const child = opencodeStore.childSessions[sessionID];
  if (child) {
    if (child.status === "running") {
      child.status = "completed";
      child.endedAt = child.endedAt || Date.now();
    }
    return;
  }

  if (sessionID === opencodeStore.activeSessionId) {
    opencodeStore.isStreaming = false;
    // Reconcile with server truth (drops optimistic artifacts, applies final
    // content). Only at the real end of the run — mid-loop this would race the
    // next step's stream.
    refreshActiveMessages({ merge });
    return;
  }
  // Green means "it finished while you were elsewhere".
  if (wasRunning) setUnread(sessionID, true);
}

// --- Server truth ------------------------------------------------------------

// Two very different reasons the probe can stop being worth making, kept apart
// on purpose. Conflating them is what made a single bad minute permanent:
//   · the route isn't on this build (404/405/501) or the build answers 200 with
//     something that isn't the documented map — nothing will change that, give up
//   · the server was unreachable, slow, or 5xx'd — the ONLY recovery a stalled
//     run has, so it must survive and keep asking
let routeUnusable = false;
let malformedAnswers = 0;
let probeOkAt = 0;

function probeUsable() {
  return !routeUnusable;
}

// When the server last answered this probe. Proof of "the server is reachable
// and talking to us" that is independent of the event stream, which is exactly
// what tells stream.js a silent stream is the stream's own fault.
export function lastRunProbeOkAt() {
  return probeOkAt;
}

// Is any session believed to be mid-run right now?
export function anyRunActive() {
  return Object.values(opencodeStore.sessionActivity).some((rec) => rec.running);
}

// The stream coming back up is a fresh chance for a route that failed while the
// server was unreachable.
export function resetRunProbe() {
  routeUnusable = false;
  malformedAnswers = 0;
}

// GET /api/session/active -> {"ses_…": {"type": "running"}}, or null when the
// question couldn't be asked. A null is "we don't know", never "nothing is
// running" — the caller must not settle anything on it.
async function fetchRunningSessions() {
  let res;
  try {
    res = await apiGet("/session/active");
  } catch {
    return null; // network/proxy: transient by assumption, keep polling
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    routeUnusable = true; // this build doesn't have it
    return null;
  }
  if (!res.ok) return null; // 5xx/401: transient, and the stream reports auth

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  // A 2xx that names nothing means nothing is running — including `data: null`,
  // which must not be read as the payload itself or every key of the envelope
  // becomes a session that is running forever.
  if (data == null) {
    probeOkAt = Date.now();
    malformedAnswers = 0;
    return {};
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    if ((malformedAnswers += 1) >= PROBE_GIVE_UP) routeUnusable = true;
    return null;
  }
  probeOkAt = Date.now();
  malformedAnswers = 0;
  return data;
}

// Bring every session we track into line with the server. Returns false when the
// server couldn't be asked, so callers can fall back.
export async function reconcileRunState() {
  if (!probeUsable()) return false;
  const running = await fetchRunningSessions();
  if (!running) return false;

  const now = Date.now();
  for (const id of Object.keys(running)) {
    const rec = activityRecord(id);
    rec.running = true;
    rec.confirmed = true;
    rec.updatedAt = now;
    // The server says this one is working: if it's the chat on screen, say so
    // even if we never saw the events that started it.
    if (id === opencodeStore.activeSessionId) opencodeStore.isStreaming = true;
  }
  for (const id of Object.keys(opencodeStore.sessionActivity)) {
    const rec = opencodeStore.sessionActivity[id];
    if (!rec.running || running[id]) continue;
    // Absent from the server, but we started it so recently that the server may
    // not have admitted it yet — see START_GRACE_MS.
    if (!rec.confirmed && now - (rec.startedAt || 0) < START_GRACE_MS) continue;
    settleRun(id);
  }
  return true;
}

// Settle as soon as the server agrees the run is over, waiting a short while
// for it to get there. For the stop button: an interrupt is acknowledged before
// the loop has actually stopped, and reconciling the transcript inside that
// window reads a turn the server has not finished writing — which is how
// stopping ended up showing less than the run had produced.
const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 300;

export async function settleWhenIdle(sessionID, opts) {
  if (!sessionID) return;
  const deadline = Date.now() + STOP_WAIT_MS;
  while (probeUsable() && Date.now() < deadline) {
    const running = await fetchRunningSessions();
    // Unanswerable, or answered "not running": either way, stop waiting.
    if (!running || !running[sessionID]) break;
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
  settleRun(sessionID, opts);
}

// A terminal event arrived. Confirm it rather than obeying it — see the header.
const pendingEnds = new Set();
let confirmTimer = null;

export function runMayHaveEnded(sessionID) {
  if (!sessionID) return;
  pendingEnds.add(sessionID);
  if (!probeUsable()) return flushPendingEnds();
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = setTimeout(async () => {
    confirmTimer = null;
    // Trust the event only when the server couldn't be asked.
    if (!(await reconcileRunState())) flushPendingEnds();
    else pendingEnds.clear();
  }, CONFIRM_MS);
}

function flushPendingEnds() {
  const ids = [...pendingEnds];
  pendingEnds.clear();
  for (const id of ids) settleRun(id);
}

// --- The poll ----------------------------------------------------------------

let pollTimer = null;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!probeUsable()) return stopPolling();
    reconcileRunState();
  }, POLL_MS);
}

// Self-driving: the poll runs exactly while something is believed to be running,
// so a caller starting a turn (or an event arriving for one) needs to know
// nothing about it.
watch(anyRunActive, (running) => (running ? startPolling() : stopPolling()), { immediate: true });

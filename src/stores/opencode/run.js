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
// after a few failed probes the poll gives up and terminal events are trusted
// on their own.
import { watch } from "vue";
import { opencodeStore } from "./state.js";
import { getJSON } from "../../lib/api.js";
import { activityRecord, setUnread } from "./activity.js";
import { clearSteers } from "./steer.js";
import { refreshActiveMessages } from "./messages.js";

// How often to ask while a run is believed to be in flight. Nothing is polled
// while everything is idle.
const POLL_MS = 4000;
// A terminal event is confirmed, not obeyed. Also coalesces the burst at the end
// of a turn (step.ended + execution.succeeded + usage on some builds).
const CONFIRM_MS = 250;
// Consecutive probe failures after which the route is treated as unavailable on
// this server, and terminal events are trusted on their own.
const PROBE_GIVE_UP = 3;

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
export function settleRun(sessionID) {
  if (!sessionID) return;
  const rec = activityRecord(sessionID);
  const wasRunning = rec.running;
  rec.running = false;
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
    refreshActiveMessages();
    return;
  }
  // Green means "it finished while you were elsewhere".
  if (wasRunning) setUnread(sessionID, true);
}

// --- Server truth ------------------------------------------------------------

let probeFailures = 0;

function probeUsable() {
  return probeFailures < PROBE_GIVE_UP;
}

// The stream coming back up is a fresh chance for a route that failed while the
// server was unreachable.
export function resetRunProbe() {
  probeFailures = 0;
}

// GET /api/session/active -> {"ses_…": {"type": "running"}}, or null when the
// question couldn't be asked (route missing, server down, bad payload).
async function fetchRunningSessions() {
  const payload = await getJSON("/session/active");
  const data = payload && (payload.data || payload);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    probeFailures += 1;
    return null;
  }
  probeFailures = 0;
  return data;
}

// Bring every session we track into line with the server. Returns false when the
// server couldn't be asked, so callers can fall back.
export async function reconcileRunState() {
  if (!probeUsable()) return false;
  const running = await fetchRunningSessions();
  if (!running) return false;

  for (const id of Object.keys(running)) {
    const rec = activityRecord(id);
    rec.running = true;
    rec.updatedAt = Date.now();
    // The server says this one is working: if it's the chat on screen, say so
    // even if we never saw the events that started it.
    if (id === opencodeStore.activeSessionId) opencodeStore.isStreaming = true;
  }
  for (const id of Object.keys(opencodeStore.sessionActivity)) {
    if (opencodeStore.sessionActivity[id].running && !running[id]) settleRun(id);
  }
  return true;
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
watch(
  () => Object.values(opencodeStore.sessionActivity).some((rec) => rec.running),
  (anyRunning) => (anyRunning ? startPolling() : stopPolling()),
  { immediate: true }
);

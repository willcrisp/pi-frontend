// Per-session agent activity — the sidebar's live status dot. Two states worth
// showing:
//   running  — a turn is in flight for that session (amber pulse)
//   unread   — the turn ended while the user was somewhere else (green)
//
// Both are tracked for every session the event stream mentions, because the
// interesting case is precisely the session you are NOT looking at. `unread` is
// persisted so a page reload doesn't quietly drop "this one answered you".
//
// This module owns "it is working"; run.js owns "it has stopped", because
// deciding that needs the server (no event says it reliably) and a transcript
// refresh, both of which live further down the graph.
import { opencodeStore } from "./state.js";
import { readArray, writeJSON } from "../../lib/storage.js";

const UNREAD_KEY = "oc.unreadSessions";

// Events that mean "this session's agent is doing something right now". Deltas
// count, not just `.started`: connecting (or reconnecting) mid-run is the
// common case, and by then the lifecycle-start event is long gone.
const RUN_ACTIVE_EVENTS = new Set([
  "session.execution.started",
  "session.step.started",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.text.started",
  "session.text.delta",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.called",
  "session.tool.progress",
  "message.part.updated",
]);

export function activityRecord(sessionID) {
  let rec = opencodeStore.sessionActivity[sessionID];
  if (!rec) {
    rec = { running: false, unread: false, updatedAt: 0 };
    opencodeStore.sessionActivity[sessionID] = rec;
  }
  return rec;
}

// The status a view should render for a session: "working" | "unread" | "".
export function sessionStatus(sessionID) {
  const rec = sessionID && opencodeStore.sessionActivity[sessionID];
  if (!rec) return "";
  if (rec.running) return "working";
  if (rec.unread) return "unread";
  return "";
}

export function setUnread(sessionID, unread) {
  const rec = activityRecord(sessionID);
  if (rec.unread === unread) return;
  rec.unread = unread;
  writeJSON(
    UNREAD_KEY,
    Object.keys(opencodeStore.sessionActivity).filter((id) => opencodeStore.sessionActivity[id].unread)
  );
}

// Mark a session as running from our own side, for the window between the
// POST and the first event coming back.
export function markRunning(sessionID) {
  if (!sessionID) return;
  const rec = activityRecord(sessionID);
  rec.running = true;
  rec.updatedAt = Date.now();
}

export function markStopped(sessionID) {
  if (!sessionID) return;
  activityRecord(sessionID).running = false;
}

// Fold one raw event into the activity map. Called for every event, BEFORE the
// active-session/child routing in events.js#handleServerEvent — that routing
// drops events for sessions that aren't in view, which is exactly the traffic
// this needs to see. The other half of the lifecycle is run.js#runMayHaveEnded,
// called from the same place.
export function trackSessionActivity(type, sessionID) {
  if (!RUN_ACTIVE_EVENTS.has(type)) return;
  markRunning(sessionID);
  // Amber outranks green: a session that started working again has nothing
  // stale left to read.
  setUnread(sessionID, false);
}

// Unread dots survive a reload; running state does not (nothing to ask the
// server for — the stream re-establishes it within a turn's first event).
for (const id of readArray(UNREAD_KEY)) activityRecord(id).unread = true;

// Sub-agent child sessions: linking a `subagent` tool call to the child session
// it dispatched.
//
// A `subagent` call spawns a whole session of its own, which streams over the
// same /api/event connection under its own sessionID. Nothing in the protocol
// reliably says "child X belongs to call Y" — the link arrives by up to three
// different routes depending on the build, and on some builds by only one:
//
//   1. tool metadata      — `metadata.metadata.sessionID` on a tool event
//                           (linkFromToolMetadata). Authoritative; wins.
//   2. the child's own    — `session.created` carrying `info.parentID`
//      announcement         (adoptChild), then guessed onto the newest
//                           unclaimed call.
//   3. history backfill   — the stored tool part's `state.metadata.sessionID`
//                           (see messages.js#backfillChildSessions).
//
// So all three feed upsertChild rather than any one being trusted alone. See
// docs/subagents-alfuat.md.
import { opencodeStore, SUBAGENT_TOOL } from "./state.js";

export function isSubagentPart(part) {
  return !!part && part.type === "tool" && part.tool === SUBAGENT_TOOL;
}

// The child session record for a dispatching tool call, or null. This is the
// single lookup the sub-agent card renders from.
export function childForCall(callID) {
  const childID = opencodeStore.callChildIndex[callID];
  return childID ? opencodeStore.childSessions[childID] || null : null;
}

// Create-or-patch a child session record. Called from all three arrival paths
// above.
export function upsertChild(childID, patch) {
  let child = opencodeStore.childSessions[childID];
  if (!child) {
    child = {
      sessionID: childID,
      parentSessionID: null,
      callID: null,
      agent: null,
      model: null,
      title: null,
      status: "running",
      messages: [],
      tokens: null,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    };
    opencodeStore.childSessions[childID] = child;
  }
  // A guessed callID (attachToPendingCall) must give way to an authoritative
  // one without leaving the guess pointing here — that would show this child's
  // transcript under someone else's dispatch.
  if (patch && patch.callID && child.callID && patch.callID !== child.callID) {
    delete opencodeStore.callChildIndex[child.callID];
  }
  if (patch) Object.assign(child, patch);
  if (child.callID) opencodeStore.callChildIndex[child.callID] = childID;
  return child;
}

// A child announces itself with `session.created` carrying info.parentID, which
// may arrive before the session.tool.progress that links it to a callID. Adopt
// it on sight so its stream has somewhere to land, then attach it to the call
// that must have dispatched it — waiting for `progress` alone leaves the card
// stuck on "starting" for the whole run on a server that doesn't emit it.
export function adoptChild(type, props, sessionID) {
  if (type !== "session.created") return null;
  const info = props.info || {};
  if (!info.parentID || info.parentID !== opencodeStore.activeSessionId) return null;
  const child = upsertChild(sessionID, {
    parentSessionID: info.parentID,
    agent: info.agent || null,
    model: info.model || null,
    title: info.title || null,
  });
  if (!child.callID) attachToPendingCall(child);
  return child;
}

// The `subagent` calls in the transcript that no child has claimed yet, oldest
// first.
function unclaimedCallIDs() {
  const ids = [];
  for (const msg of opencodeStore.messages) {
    for (const part of msg.parts || []) {
      if (!isSubagentPart(part) || !part.callID) continue;
      if (opencodeStore.callChildIndex[part.callID]) continue;
      ids.push(part.callID);
    }
  }
  return ids;
}

// Attach a freshly announced child to the most recent unclaimed dispatch. The
// authoritative link is `metadata.sessionID` on the tool call, and it wins
// wherever it turns up (see linkFromToolMetadata) — this is the fallback for
// when it never does. A child is created by the dispatch that is in flight, so
// the newest unclaimed call is the right guess; only concurrent dispatches
// could reorder, and mislabelling which of two live cards is which beats
// showing neither.
function attachToPendingCall(child) {
  const pending = unclaimedCallIDs();
  const callID = pending[pending.length - 1];
  if (!callID) return;
  child.callID = callID;
  opencodeStore.callChildIndex[callID] = child.sessionID;
}

// Pull the child session id out of a tool event's metadata, if it's there.
// Note the doubled nesting: the event's own `metadata` wraps the tool's.
// Observed on `session.tool.progress`; handled on every tool event because a
// build that reports it elsewhere (or only once, on success) should still link.
// `structured` is the same field's name on builds that emit the
// `session.next.tool.*` vocabulary, which carry no `metadata` at all.
export function linkFromToolMetadata(props) {
  const meta = (props.metadata && props.metadata.metadata) || props.structured;
  if (!meta || !meta.sessionID || !props.callID) return;
  const patch = { callID: props.callID, parentSessionID: props.sessionID };
  if (meta.status) patch.status = meta.status;
  upsertChild(meta.sessionID, patch);
}

// The SSE event reducer: one server event in, store mutations out.
//
// Envelope is `{ id, type, data }`; the payload lives on `data`. Event
// vocabulary was verified by tapping GET /api/event on a live server. This build
// does NOT emit the classic Part model (message.updated / message.part.updated /
// session.idle) — those never fire, which is why assistant replies used to never
// render and the streaming flag never cleared. What it actually emits per prompt:
//
//   session.input.admitted -> session.execution.started -> session.input.promoted
//   -> session.step.started
//      -> session.reasoning.started / .delta / .ended     (ordinal-keyed)
//      -> session.tool.input.started / .delta / .ended    (callID-keyed)
//      -> session.tool.called -> [.progress] -> .success
//      -> session.text.started / .delta / .ended          (ordinal-keyed)
//   -> session.step.ended -> session.usage.updated -> session.execution.succeeded
//
// The classic-Part events are still handled: different builds emit different
// vocabulary and the point of this table is that supporting one more is adding
// one entry, not editing a branch someone else depends on.
//
// ── Two spellings of the same vocabulary ─────────────────────────────────────
// The current opencode-ai@next (0.0.0-next-202606270058, verified against a live
// `opencode2 serve` and its /openapi.json) emits the whole per-turn vocabulary
// under a `session.next.` prefix instead — `session.next.step.started`,
// `session.next.text.delta`, and so on — and no session.execution.* at all.
// Rather than duplicate 20 entries, the infix is normalized away on the way in
// (canonicalType) so one table serves both. Keys below are therefore canonical
// names, not necessarily what any single build puts on the wire.
//
// It also identifies streaming parts by `textID`/`reasoningID` where the other
// build uses `ordinal` — partKey takes whichever came.
//
// **What ends a run is deliberately NOT decided here.** No event answers that
// across builds, and on both of them a steered prompt continues the agent loop
// past a step's end; see run.js.
//
// ── Adding or changing an event ──────────────────────────────────────────────
// Add a key to HANDLERS below. Each handler receives one context object:
//
//   { type, props, child, messages, sessionID }
//
//   props     — the event's `data`
//   sessionID — the session this event is about, dug out of whichever of the
//               three places the payload carries it
//   child    — the sub-agent child session record when this event belongs to
//              one, else null. **Check it.** A non-null `child` means the event
//              is a sub-agent's, so it must not touch session-wide state
//              (the streaming flag, model selection, usage) — that belongs to
//              the session in view.
//   messages — the transcript to write into: the active session's, or the
//              child's own. Always use this rather than opencodeStore.messages.
//
// An event with no entry is ignored, which is the correct default; the explicit
// no-op entries below exist to say "seen, deliberately nothing to do".
import { opencodeStore } from "./state.js";
import { adoptChild, linkFromToolMetadata } from "./children.js";
import { persistSelection, resolveVariant } from "./models.js";
import { trackSessionActivity } from "./activity.js";
import { resolveSteer } from "./steer.js";
import { applyUsageUpdate, scheduleContextRefresh, updateSessionStats } from "./context.js";
import { reportRunError } from "./errors.js";
import { findOrCreateMessage, recomputeText, toolContentText } from "./messages.js";
import { isRunEndEvent, runMayHaveEnded } from "./run.js";
import { loadModels } from "./catalog.js";
import { handlePermissionEvent } from "../permission.js";
import { handleQuestionEvent } from "../question.js";
import { loadIntegrations } from "../providers.js";

// --- Part helpers ------------------------------------------------------------

// Upsert a part on a message by a synthetic stable id. Streaming events identify
// text/reasoning parts by `ordinal` and tool parts by `callID`, none of which are
// part ids, so we derive one per kind (`text:0`, `reasoning:0`, `tool:call_…`).
function upsertPart(msg, id, patch) {
  const idx = msg.parts.findIndex((p) => p.id === id);
  if (idx >= 0) {
    msg.parts[idx] = { ...msg.parts[idx], ...patch };
    return msg.parts[idx];
  }
  const part = { id, ...patch };
  msg.parts.push(part);
  return part;
}

function appendPartText(msg, id, kind, delta) {
  const existing = msg.parts.find((p) => p.id === id);
  upsertPart(msg, id, { type: kind, text: (existing?.text || "") + (delta || "") });
}

// The synthetic part id for a streaming text/reasoning part. Builds identify the
// part by `ordinal`, or by `textID`/`reasoningID` — take whichever came, because
// keying every part of a message the same way merges them, and then `.ended`
// (which replaces rather than appends) drops everything but the last one.
function partKey(kind, props) {
  const id = props.ordinal ?? props.textID ?? props.reasoningID ?? 0;
  return `${kind}:${id}`;
}

// Streaming events carry the assistant message id but no role/time, so seed those.
function assistantMessageFor(list, props) {
  const msg = findOrCreateMessage(list, props.assistantMessageID, "assistant");
  msg.role = "assistant";
  if (!msg.createdAt) msg.createdAt = Date.now();
  return msg;
}

// True when session-wide state should follow this event: it isn't a sub-agent's,
// and it isn't addressed to some other session.
function ownsSession(child, props) {
  return !child && (!props.sessionID || props.sessionID === opencodeStore.activeSessionId);
}

// A single credential change fires several integration events; coalesce them
// so one connect doesn't trigger a burst of catalog reloads.
let integrationTimer = null;
function scheduleIntegrationRefresh() {
  if (integrationTimer) clearTimeout(integrationTimer);
  integrationTimer = setTimeout(() => {
    integrationTimer = null;
    loadIntegrations();
    loadModels();
  }, 500);
}

// --- Shared handler shapes ---------------------------------------------------

// Text and reasoning stream identically (see partKey for what identifies a
// part); only the part type differs. `kind` is baked in per registration below.
const streamStarted = (kind) => ({ props, child, messages }) => {
  const msg = assistantMessageFor(messages, props);
  upsertPart(msg, partKey(kind, props), { type: kind, text: "" });
  if (ownsSession(child, props)) opencodeStore.isStreaming = true;
};

const streamDelta = (kind) => ({ props, child, messages }) => {
  const msg = assistantMessageFor(messages, props);
  appendPartText(msg, partKey(kind, props), kind, props.delta);
  if (kind === "text") recomputeText(msg);
  if (ownsSession(child, props)) opencodeStore.isStreaming = true;
};

// `.ended` carries the authoritative full text, so replace rather than append —
// this also repairs any delta that was missed.
const streamEnded = (kind) => ({ props, messages }) => {
  const msg = assistantMessageFor(messages, props);
  upsertPart(msg, partKey(kind, props), {
    type: kind,
    text: props.text || "",
    phase: props.state && props.state.phase,
  });
  if (kind === "text") recomputeText(msg);
};

// A turn failing. The streaming flag is NOT cleared here — a failed step can be
// retried by the same agent loop (session.next.retried), so whether the run is
// over is settled by run.js like any other ending. This is only the report.
//
// A sub-agent failing is reported on its card, not as a session-wide error
// banner — the parent turn is still alive and will handle the tool error.
// `readMessage` differs per event because the error shapes do.
const failRun = (readMessage) => ({ props, child }) => {
  const message = readMessage(props.error) || "Execution failed";
  if (child) {
    child.status = "error";
    child.error = message;
    child.endedAt = Date.now();
    return;
  }
  reportRunError(message);
};

const ignore = () => {};

// --- The table ---------------------------------------------------------------

const HANDLERS = {
  "server.connected": () => {
    opencodeStore.connected = true;
  },

  "session.execution.started": ({ props, child }) => {
    if (child) {
      child.status = "running";
      child.startedAt = child.startedAt || Date.now();
    } else if (ownsSession(child, props)) {
      opencodeStore.isStreaming = true;
    }
  },

  "session.model.selected": ({ props }) => {
    // Selection is per-session state, so ignore events for other sessions.
    if (props.sessionID && props.sessionID !== opencodeStore.activeSessionId) return;
    if (props.providerID && props.modelID) {
      opencodeStore.selectedModel = { providerID: props.providerID, modelID: props.modelID };
    }
    opencodeStore.thinkingLevel = resolveVariant(
      opencodeStore.selectedModel,
      props.variant || opencodeStore.thinkingLevel
    );
    persistSelection();
  },

  // Admission is acknowledged and dropped: the user message is already appended
  // optimistically by sendPrompt (or tracked in pendingSteers by sendSteer), and
  // the run's end reconciles against the server, so re-adding it here would
  // duplicate it.
  "session.input.admitted": ignore,
  "session.prompt.admitted": ignore,
  "shell.created": ignore,
  "shell.exited": ignore,
  // The agent loop is having another go at a failed step; it never stopped, so
  // there is nothing to settle and the error already showed.
  "session.retried": ignore,

  // No state today — the PTY runner uses a one-shot lifecycle (see pty.js).
  "pty.created": ignore,
  "pty.exited": ignore,
  "pty.deleted": ignore,

  // Promotion is the moment a steered/queued input actually reaches the agent,
  // so it's what retires the pending entry. Two spellings, because builds
  // disagree (`session.input.promoted` on the ALF-UAT target, `session.prompted`
  // — wire name `session.next.prompted` — on opencode-ai@next).
  "session.input.promoted": ({ props, sessionID }) => resolveSteer(sessionID, props.messageID || props.id),
  "session.prompted": ({ props, sessionID }) => resolveSteer(sessionID, props.messageID || props.id),

  "session.step.started": ({ props, child, messages }) => {
    const msg = assistantMessageFor(messages, props);
    if (props.model) {
      msg.providerID = props.model.providerID;
      msg.modelID = props.model.id;
      // The dispatch tool call doesn't say which model the sub-agent got;
      // its first step does.
      if (child && !child.model) child.model = props.model;
    }
    if (ownsSession(child, props)) opencodeStore.isStreaming = true;
  },

  "session.reasoning.started": streamStarted("reasoning"),
  "session.text.started": streamStarted("text"),
  "session.reasoning.delta": streamDelta("reasoning"),
  "session.text.delta": streamDelta("text"),
  "session.reasoning.ended": streamEnded("reasoning"),
  "session.text.ended": streamEnded("text"),

  "session.tool.input.started": ({ props, messages }) => {
    const msg = assistantMessageFor(messages, props);
    upsertPart(msg, `tool:${props.callID}`, {
      type: "tool",
      tool: props.name,
      callID: props.callID,
      state: { status: "pending" },
    });
  },

  "session.tool.input.ended": ({ props, messages }) => {
    const msg = assistantMessageFor(messages, props);
    // `text` is the raw JSON argument string; parse for display when it's valid.
    let input;
    try {
      input = JSON.parse(props.text);
    } catch {
      input = props.text;
    }
    upsertPart(msg, `tool:${props.callID}`, { input });
  },

  "session.tool.called": ({ props, messages }) => {
    const msg = assistantMessageFor(messages, props);
    const patch = { type: "tool", callID: props.callID, state: { status: "running" } };
    // The name is on `tool` here and on `name` in tool.input.started, depending
    // on the build. Without it a `subagent` dispatch renders as a generic tool
    // row instead of a card, so take it from whichever event brought it.
    if (props.tool || props.name) patch.tool = props.tool || props.name;
    // Don't clobber the arguments `session.tool.input.ended` already parsed:
    // they're the same call's input, and a build that abbreviates them here
    // would otherwise erase the sub-agent's task text from its card.
    const existing = msg.parts.find((p) => p.id === `tool:${props.callID}`);
    if (props.input !== undefined && !(existing && existing.input !== undefined)) {
      patch.input = props.input;
    }
    upsertPart(msg, `tool:${props.callID}`, patch);
    linkFromToolMetadata(props);
  },

  "session.tool.progress": ({ props, messages }) => {
    const msg = assistantMessageFor(messages, props);
    upsertPart(msg, `tool:${props.callID}`, { state: { status: "running" } });
    // For a `subagent` call this is where the live link between the dispatching
    // tool call and its child session usually arrives.
    linkFromToolMetadata(props);
  },

  "session.tool.success": ({ props, messages }) => {
    const msg = assistantMessageFor(messages, props);
    upsertPart(msg, `tool:${props.callID}`, {
      state: {
        status: "completed",
        output: toolContentText(props.content),
        // Keep the linkage on the part itself: the card reads it, and a later
        // history refresh reconciles against the same field.
        metadata: (props.metadata && props.metadata.metadata) || undefined,
      },
    });
    linkFromToolMetadata(props);
    // The child's own execution.succeeded may never arrive if we connected
    // mid-run, so settle it from the parent's side too.
    const settled = opencodeStore.callChildIndex[props.callID];
    const c = settled && opencodeStore.childSessions[settled];
    if (c && c.status === "running") {
      c.status = "completed";
      c.endedAt = c.endedAt || Date.now();
    }
  },

  // Error-event names for a failed tool call are unverified against a live server
  // (no failing call was captured); both spellings are handled so whichever the
  // server emits surfaces the error instead of leaving the call stuck "running".
  "session.tool.error": toolFailed,
  "session.tool.failed": toolFailed,

  // Whether this is also the end of the run is run.js's call — see isRunEndEvent.
  "session.step.ended": ({ props, child, messages }) => {
    const msg = assistantMessageFor(messages, props);
    msg.tokens = props.tokens;
    msg.cost = props.cost;
    if (child) return;
    // On a build with no session.usage.updated (opencode-ai@next has none — the
    // step's own event is where tokens and cost arrive) this is the only place
    // the usage popover ever hears a number.
    updateSessionStats(msg);
    scheduleContextRefresh();
  },

  // Parent and child are metered separately — each emits its own
  // session.usage.updated — so child totals go on the child record and are
  // additive with the session's, never a double-count of it.
  "session.usage.updated": ({ props, child }) => {
    if (child) {
      child.tokens = props.tokens || child.tokens;
      return;
    }
    applyUsageUpdate(props);
    // Usage moving is the only signal that context has moved, so this is where
    // server truth is re-read. Debounced — a turn emits several.
    scheduleContextRefresh();
  },

  // The end-of-run events (session.idle, session.execution.succeeded /
  // .completed / .aborted, session.step.failed …) are handled ahead of this
  // table, in handleServerEvent — settling a run needs to happen for every
  // session, not just the one on screen, and it is confirmed against the server
  // rather than taken from the event. These entries only report what failed.
  "session.execution.failed": failRun((err) => (err && err.message) || (err && err.type)),
  "session.step.failed": failRun((err) => (err && err.message) || (err && err.name)),
  "session.error": failRun(
    (err) => (err && err.data && err.data.message) || (err && err.name) || "Session error"
  ),

  // Credentials changed — on this server or another client. Reload the
  // integration list AND the model catalog: connecting a provider is exactly
  // what makes new models appear, and stale pickers after adding a key were the
  // whole reason this needed a manual reload.
  "integration.updated": scheduleIntegrationRefresh,
  "integration.connection.updated": scheduleIntegrationRefresh,

  "message.updated": ({ props, child, messages }) => {
    const info = props.info;
    if (!info) return;
    const msg = findOrCreateMessage(messages, info.id, info.role);
    msg.role = info.role;
    msg.tokens = info.tokens;
    msg.cost = info.cost;
    msg.error = info.error || null;
    msg.createdAt = (info.time && info.time.created) || msg.createdAt || null;

    if (info.role === "assistant" && !child) updateSessionStats(info);
  },

  "message.part.updated": ({ props, child, messages }) => {
    // SSE parts use the classic Part shape (text/reasoning/tool{tool,state}/file),
    // which MessageView renders directly. Upsert by part id.
    const part = props.part;
    if (!part) return;
    if (ownsSession(child, props)) opencodeStore.isStreaming = true;
    const msg = findOrCreateMessage(messages, part.messageID);
    const idx = msg.parts.findIndex((p) => p.id === part.id);
    if (idx >= 0) msg.parts[idx] = part;
    else msg.parts.push(part);
    recomputeText(msg);
  },

  "message.part.removed": ({ props, messages }) => {
    const messageID = props.messageID || (props.part && props.part.messageID);
    const partID = props.partID || (props.part && props.part.id);
    const msg = messages.find((m) => m.id === messageID);
    if (!msg) return;
    msg.parts = msg.parts.filter((p) => p.id !== partID);
    recomputeText(msg);
  },

  "message.removed": ({ props, messages }) => {
    const messageID = props.messageID || (props.info && props.info.id);
    // Splice rather than reassign — `messages` may be a child's own array.
    const at = messages.findIndex((m) => m.id === messageID);
    if (at >= 0) messages.splice(at, 1);
  },
};

function toolFailed({ props, messages }) {
  const msg = assistantMessageFor(messages, props);
  const err = props.error;
  upsertPart(msg, `tool:${props.callID}`, {
    state: {
      status: "error",
      error: (err && (err.message || err.type)) || props.message || "tool call failed",
    },
  });
}

// --- Entry point -------------------------------------------------------------

// `session.next.foo` and `session.foo` are the same event under two builds'
// spellings (see the header), so the infix is dropped once, here, and everything
// downstream — this table, activity.js, run.js — only ever sees the canonical
// name. `session.next.prompted` therefore arrives as `session.prompted`.
function canonicalType(type) {
  return type.startsWith("session.next.") ? `session.${type.slice(13)}` : type;
}

// Exported as the reducer for the event stream — the SSE subscription in
// stream.js is its only caller today, but it is also the seam to drive the store
// from a session-scoped stream or a replay.
export function handleServerEvent(event) {
  if (!event || !event.type) return;
  const { data } = event;
  const type = canonicalType(event.type);
  const props = data || {};

  // Interactive gates are dispatched BEFORE the session router below, because
  // they must never be dropped: they carry their own sessionID for the reply
  // and they block a run until answered, so a gate raised by a sub-agent (or by
  // a session we aren't currently viewing) still has to reach the user.
  if (type === "permission.v2.asked" || type === "permission.v2.replied") {
    handlePermissionEvent(event);
    return;
  }
  // question.v2.* — structured mid-execution asks, same contract.
  if (type.startsWith("question.v2.")) {
    handleQuestionEvent(event);
    return;
  }

  const sessionID =
    (props.part && props.part.sessionID) ||
    (props.info && props.info.sessionID) ||
    props.sessionID;

  // Run state first: the sidebar dot is driven for every session, and settling a
  // run has to happen even for one we aren't looking at — both would be lost to
  // the routing below, which drops events for sessions that aren't on screen.
  if (sessionID) {
    trackSessionActivity(type, sessionID);
    if (isRunEndEvent(type, props)) runMayHaveEnded(sessionID);
  }

  // A sub-agent's child session emits the SAME event vocabulary under its own
  // sessionID, so events are routed rather than filtered: the active session
  // drives the main transcript, a known child drives its own, and anything else
  // is dropped.
  let child = null;
  let messages = opencodeStore.messages;
  if (sessionID && opencodeStore.activeSessionId && sessionID !== opencodeStore.activeSessionId) {
    child = opencodeStore.childSessions[sessionID] || adoptChild(type, props, sessionID);
    if (!child) return;
    messages = child.messages;
  }

  const handler = HANDLERS[type];
  if (handler) handler({ type, props, child, messages, sessionID });
}

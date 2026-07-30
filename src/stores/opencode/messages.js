// The transcript: loading a session's history, normalizing the REST message
// shape into the one the view layer renders, and rebuilding sub-agent cards
// from it.
//
// There are two wire shapes for the same content and this module is where they
// are reconciled: the SSE stream delivers the classic Part shape
// (text/reasoning/tool{tool,state}/file), while GET /session/:id/message returns
// `Session.Message.Info` discriminated by `type` with assistant content under
// `content[]`. Everything below normalizes toward the SSE shape, because that is
// what MessageView renders — so a restored transcript and a live one look
// identical to the components.
import { opencodeStore } from "./state.js";
import { getJSON, unwrap } from "../../lib/api.js";
import { isSubagentPart, upsertChild } from "./children.js";
import { restoreSessionModel } from "./models.js";
import { setUnread } from "./activity.js";
import { refreshSessionContext, resetContextUsage } from "./context.js";
import { switchDraft } from "./drafts.js";

// Find or create a message shell by id in `list` — the active session's
// transcript, or a sub-agent child's own transcript.
export function findOrCreateMessage(list, messageID, role) {
  let msg = list.find((m) => m.id === messageID);
  if (!msg) {
    msg = { id: messageID, role: role || "assistant", parts: [], text: "", createdAt: null };
    list.push(msg);
  }
  return msg;
}

// Recompute the convenience `text` field from a message's non-synthetic text parts.
export function recomputeText(msg) {
  msg.text = msg.parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text || "")
    .join("");
}

// Open a session: make it active, reset everything that belonged to the one
// being left, and load its history.
export async function connectToSession(sessionID) {
  if (!sessionID) return;
  const previousID = opencodeStore.activeSessionId;
  opencodeStore.activeSessionId = sessionID;
  // File the outgoing chat's half-typed prompt and bring up this one's, before
  // any await — `draft` must never be the previous chat's text while the new
  // session id is already active.
  switchDraft(previousID, sessionID);
  // Opening a chat reads it — and if its agent is still mid-turn, come back up
  // streaming rather than pretending the run ended when we navigated away.
  setUnread(sessionID, false);
  opencodeStore.isStreaming = !!(opencodeStore.sessionActivity[sessionID] || {}).running;
  // Sub-agent state belongs to the session being left, not the one being opened.
  opencodeStore.childSessions = {};
  opencodeStore.callChildIndex = {};
  opencodeStore.revertStaged = null;
  // Steers are tracked for the session in view only (sendSteer targets the
  // active session); the ones left here belong to the chat being left.
  opencodeStore.pendingSteers = [];
  resetContextUsage();
  restoreSessionModel(sessionID);

  await refreshActiveMessages();
  await refreshSessionContext(sessionID);
}

// One session's transcript, normalized and ordered the way the view layer wants
// it, or null when the request failed (which is not the same as an empty chat —
// callers must not treat a failure as "this session has no messages" and wipe
// what they already have).
//
// The endpoint returns newest-first; the transcript renders top-to-bottom
// oldest-first, so order by creation time ascending. The sort is stable, so
// anything without a timestamp keeps its relative position.
export async function fetchSessionMessages(sessionID) {
  const payload = await getJSON(`/session/${sessionID}/message`);
  if (!payload) return null;
  return unwrap(payload)
    .map(normalizeRestMessage)
    .filter(Boolean)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// Serialises the write, not the fetch: two refreshes can be in flight at once
// (a settle racing a session switch, a stall resync racing a settle) and the
// slower one must not land on top of the newer one's answer.
let refreshSeq = 0;

// Replace the transcript with the server's, or — with `merge` — reconcile
// against it without losing ground.
//
// `merge` exists for the two moments where the server is authoritative about
// what it HAS but not about what we've already been shown: recovering from a
// gap in the event stream mid-run, and the stop button landing before the
// interrupted step has been flushed. There, a plain replace would blank the
// half-streamed assistant message that is on screen. At the natural end of a
// run the plain replace is still right — that's what drops optimistic
// artifacts.
export async function refreshActiveMessages({ merge = false } = {}) {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  const seq = ++refreshSeq;

  const list = await fetchSessionMessages(sessionID);
  if (!list) {
    console.error(`Failed to fetch messages for session ${sessionID}`);
    return;
  }
  // The user navigated, or a newer refresh already answered: this one is stale,
  // and writing it would put another session's transcript on screen.
  if (seq !== refreshSeq || sessionID !== opencodeStore.activeSessionId) return;
  opencodeStore.messages = merge ? mergeTranscript(opencodeStore.messages, list) : list;

  // Server truth just landed, and it carries the sub-agent linkage each
  // dispatch needs. Awaited so a caller that refreshes and then reads
  // childForCall sees the result. A late return for a session the user has
  // navigated away from is dropped inside.
  if (sessionID === opencodeStore.activeSessionId) await backfillChildSessions();
}

// Optimistically append the user's own message, so the prompt appears the
// instant it's sent rather than when the server echoes it back.
export function appendLocalUserMessage(text, attachments) {
  const id = `user-${Date.now()}`;
  opencodeStore.messages.push({
    id,
    role: "user",
    // Marks a message the server has never heard of, carrying an id of our own
    // rather than a `msg_…`. It is how mergeTranscript knows this one is
    // superseded once the server's copy of the same prompt shows up.
    local: true,
    parts: [
      ...(text ? [{ type: "text", text }] : []),
      ...attachments.map((f, i) => ({ id: `${id}-f${i}`, type: "file", ...f })),
    ],
    text,
  });
  return id;
}

// --- Merging server truth into a transcript that is mid-stream ---------------

// How much of a message is actually there. Compared, not trusted absolutely:
// the question a merge asks is only "which of these two copies has more of it".
function contentWeight(msg) {
  const parts = msg.parts || [];
  return parts.reduce((n, p) => n + ((p.text || "").length || 1), parts.length);
}

// Server list + what we hold, keeping whichever copy of each message is further
// along. Server order wins; messages only we have (an assistant message still
// streaming, which the server won't persist until the step ends) keep their
// place at the end.
function mergeTranscript(local, incoming) {
  const localIDs = new Set(local.map((m) => m.id));
  const incomingIDs = new Set(incoming.map((m) => m.id));
  // What the server has that we had never seen. The echo of an optimistic
  // prompt is in here once the server has taken it — and only then.
  const fresh = incoming.filter((m) => !localIDs.has(m.id));

  const merged = incoming.map((server) => {
    const mine = local.find((m) => m.id === server.id);
    if (!mine) return server;
    // Scalars (tokens, cost, error, createdAt) are the server's either way; only
    // the parts can be behind, and only in one direction.
    return contentWeight(mine) > contentWeight(server)
      ? { ...server, parts: mine.parts, text: mine.text }
      : server;
  });

  for (const mine of local) {
    if (incomingIDs.has(mine.id)) continue;
    // Our optimistic copy of a prompt, dropped only once the server's own copy
    // of it has arrived — same text under a different id, and keeping both
    // shows the prompt twice. Until then it stays: a mid-run resync must not
    // take the user's own message off the screen, and an interrupted turn may
    // never be recorded server-side at all.
    if (mine.local && fresh.some((m) => m.role === mine.role && m.text === mine.text)) continue;
    merged.push(mine);
  }
  return merged;
}

// --- Sub-agent backfill ------------------------------------------------------

// Rebuild sub-agent cards from the transcript. Runs after every message
// refresh, not just on session switch: a dispatch whose live linkage never
// arrived is only recoverable from the stored tool part, and until this ran
// again its card sat on "starting" forever — the turn was over, the answer was
// on screen, and the card still claimed the sub-agent was starting up.
async function backfillChildSessions() {
  const parentID = opencodeStore.activeSessionId;
  const dispatches = [];
  for (const msg of opencodeStore.messages) {
    for (const part of msg.parts || []) {
      if (!isSubagentPart(part) || !part.callID) continue;
      const meta = (part.state && part.state.metadata) || null;
      dispatches.push({
        childID: (meta && meta.sessionID) || opencodeStore.callChildIndex[part.callID] || null,
        callID: part.callID,
        meta: meta || {},
        part,
      });
    }
  }
  if (!dispatches.length) return;

  await resolveUnlinkedDispatches(dispatches, parentID);

  await Promise.all(
    dispatches.map(async ({ childID, callID, meta, part }) => {
      if (!childID) return;
      // A finished child whose transcript is already loaded needs no refetch —
      // this now runs on every message refresh, so it has to stay cheap.
      const loaded = opencodeStore.childSessions[childID];
      if (loaded && loaded.status !== "running" && loaded.messages.length) {
        upsertChild(childID, { callID });
        return;
      }
      const child = upsertChild(childID, {
        callID,
        parentSessionID: parentID,
        // A run still in flight when the page reloaded stays "running" and the
        // live stream will settle it.
        status: meta.status || (part.state && part.state.status) || "completed",
        task: part.input && part.input.prompt,
        title: (part.input && part.input.description) || null,
        agent: (part.input && part.input.agent) || null,
      });
      const [info, list] = await Promise.all([
        getJSON(`/session/${childID}`),
        fetchSessionMessages(childID),
      ]);
      if (info) {
        const d = info.data || info;
        child.agent = d.agent || child.agent;
        child.model = d.model || child.model;
        child.title = d.title || child.title;
        child.tokens = d.tokens || child.tokens;
        child.startedAt = (d.time && d.time.created) || child.startedAt;
      }
      if (list) child.messages = list;
    })
  );
}

// Last resort for dispatches that never got a child session id from anywhere:
// list the sessions and take this one's children. `GET /api/session` has no
// parentID filter, so it's a client-side scan, and there is no field anywhere
// that says which child came from which call — so this only matches when the
// counts line up exactly, pairing them in order (dispatch order in the
// transcript against child creation order). Ambiguous by construction
// otherwise, and a wrong pairing is worse than none.
async function resolveUnlinkedDispatches(dispatches, parentID) {
  const unlinked = dispatches.filter((d) => !d.childID);
  if (!unlinked.length || !parentID) return;

  const payload = await getJSON("/session");
  if (!payload) return;
  const claimed = new Set(dispatches.map((d) => d.childID).filter(Boolean));
  const candidates = unwrap(payload)
    .filter((s) => s.parentID === parentID && !claimed.has(s.id))
    .sort((a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0));

  if (candidates.length !== unlinked.length) return;
  unlinked.forEach((d, i) => {
    d.childID = candidates[i].id;
  });
}

// --- REST -> view-layer normalization ----------------------------------------

// Normalize a REST Session.Message.Info (discriminated by `type`) into the canonical shape
// the view layer consumes ({ id, role, parts, text, tokens, cost, error, createdAt }).
// Only user/assistant render; other message types (system/synthetic/skill/shell/compaction/
// agent-switched/model-switched) are skipped.
function normalizeRestMessage(m) {
  if (!m || !m.type) return null;
  const createdAt = (m.time && m.time.created) || null;

  if (m.type === "user") {
    const text = m.text || "";
    const files = Array.isArray(m.files) ? m.files : [];
    return {
      id: m.id,
      role: "user",
      parts: [
        ...(text ? [{ type: "text", text }] : []),
        ...files.map((f, i) => ({ id: `${m.id}-f${i}`, ...normalizeUserFile(f) })),
      ],
      text,
      createdAt,
    };
  }

  if (m.type === "assistant") {
    const content = Array.isArray(m.content) ? m.content : [];
    const parts = content.map(normalizeContentItem).filter(Boolean);
    const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("");
    return {
      id: m.id,
      role: "assistant",
      parts,
      text,
      tokens: m.tokens,
      cost: m.cost,
      error: m.error || null,
      createdAt,
    };
  }

  return null;
}

// A stored user attachment is `{data, mime, source, name?}` (`Prompt.FileAttachment`).
// `source.type` is "inline" (base64 in `data`, rebuilt into a data URL so the view can
// show it) or "uri" (the original location in `source.uri`).
function normalizeUserFile(f) {
  const inline = f.data ? `data:${f.mime || "application/octet-stream"};base64,${f.data}` : "";
  return {
    type: "file",
    filename: f.name || "",
    mime: f.mime || "",
    url: f.source && f.source.type === "uri" ? f.source.uri : inline,
  };
}

// Map a REST assistant `content[]` item to a canonical part (matching the SSE Part shape
// that MessageView renders: text/reasoning/tool{tool,state:{status,output,error}}).
function normalizeContentItem(item) {
  if (!item || !item.type) return null;
  if (item.type === "text") return { type: "text", text: item.text || "" };
  if (item.type === "reasoning") return { type: "reasoning", text: item.text || "" };
  if (item.type === "tool") {
    return {
      type: "tool",
      tool: item.name,
      callID: item.id,
      // Stored calls keep their arguments under state.input; the live path gets
      // them from session.tool.input.ended. Both land on `input` so the view
      // layer has one place to look.
      input: item.state && item.state.input,
      state: normalizeRestToolState(item.state),
    };
  }
  return null;
}

function normalizeRestToolState(state) {
  if (!state) return { status: "pending" };
  const out = { status: state.status };
  if (state.status === "completed") out.output = toolContentText(state.content);
  else if (state.status === "error") out.error = (state.error && state.error.message) || "error";
  // A `subagent` call stores its child session id here — the history-side half
  // of the linkage that session.tool.progress provides live. Must survive
  // normalization or restored transcripts lose their sub-agent cards.
  if (state.metadata) out.metadata = state.metadata;
  return out;
}

export function toolContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && c.type === "text" ? c.text : (c && c.text) || ""))
    .filter(Boolean)
    .join("\n");
}

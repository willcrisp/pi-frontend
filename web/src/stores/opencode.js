// OpenCode2 Client Store
// Direct HTTP REST + SSE client for the opencode2 "HttpApi" surface (routes under /api,
// list responses wrapped in { data }). Reached through the dev proxy via apiBase().
import { reactive } from "vue";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { apiBase, authHeaders } from "./ssh.js";
import { handlePermissionEvent } from "./permission.js";
import { handleQuestionEvent } from "./question.js";
import { loadIntegrations } from "./providers.js";

export const opencodeStore = reactive({
  connected: false,
  activeSessionId: null,
  activeSession: null,
  messages: [],
  forkMessages: [],
  isStreaming: false,
  availableModels: [], // [{ providerID, modelID, label, contextLimit, variants }]
  selectedModel: null, // { providerID, modelID }
  thinkingLevel: "", // selected model variant name ("" only while no variant-capable model is selected)
  availableAgents: [],
  // Agents with `mode: "subagent"` (general, explore, plus anything defined in
  // .opencode/agent). Kept out of availableAgents so they never show in the
  // composer's picker — they're dispatched by the `subagent` tool, not selected
  // as the session agent — but retained here as the live roster the sub-agent
  // manager (subagents.js) joins its definition files against. `hidden` ones are
  // included: for a subagent that flag only hides it from the `@` menu, and
  // dropping them here would make them unmanageable.
  subagentRoster: [],
  selectedAgent: "build",
  draft: "",
  error: null,
  // A staged (previewed, not yet committed) revert: { messageID } or null.
  // See stageRevert/commitRevert/clearRevert.
  revertStaged: null,
  sessionStats: {
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    // `percent` is derived from message tokens against the model's catalog
    // limit until GET /session/{id}/context answers, after which the server's
    // own accounting wins — `fromServer` records which one you're looking at
    // so the local estimate never silently overwrites server truth.
    contextUsage: { percent: 0, used: null, limit: null, fromServer: false },
  },
  commands: [],
  skills: [],
  // Sub-agent dispatches. A `subagent` tool call spawns a CHILD SESSION whose
  // turn streams over this same /api/event connection under its own sessionID.
  // childSessions is keyed by that child sessionID; callChildIndex maps the
  // dispatching tool call to it so the view layer can look up by callID.
  // See docs/subagents-alfuat.md.
  childSessions: {},
  callChildIndex: {},
  // Per-session agent activity, keyed by session id:
  //   { running: bool, unread: bool, updatedAt: ms }
  // The event stream carries EVERY session, not just the one in view, so this
  // is maintained for all of them and outlives navigating away — that is the
  // whole point of the sidebar dot (amber pulse = working, green = it finished
  // while you were looking at another chat). See trackSessionActivity.
  sessionActivity: {},
});

// Name of the tool whose calls dispatch a sub-agent (verified live on the
// ALF-UAT build; `functions.subagent` in the model's own tool list).
export const SUBAGENT_TOOL = "subagent";

export function isSubagentPart(part) {
  return !!part && part.type === "tool" && part.tool === SUBAGENT_TOOL;
}

// The child session record for a dispatching tool call, or null. This is the
// single lookup the sub-agent card renders from.
export function childForCall(callID) {
  const childID = opencodeStore.callChildIndex[callID];
  return childID ? opencodeStore.childSessions[childID] || null : null;
}

// Create-or-patch a child session record. Called from three places: the live
// linkage signal (session.tool.progress on the parent), the child's own
// session.created, and history backfill.
function upsertChild(childID, patch) {
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
  if (patch) Object.assign(child, patch);
  if (child.callID) opencodeStore.callChildIndex[child.callID] = childID;
  return child;
}

// A child announces itself with `session.created` carrying info.parentID, which
// may arrive before the session.tool.progress that links it to a callID. Adopt
// it on sight so its stream has somewhere to land; the callID is filled in when
// the progress event turns up.
function adoptChild(type, props, sessionID) {
  if (type !== "session.created") return null;
  const info = props.info || {};
  if (!info.parentID || info.parentID !== opencodeStore.activeSessionId) return null;
  return upsertChild(sessionID, {
    parentSessionID: info.parentID,
    agent: info.agent || null,
    model: info.model || null,
    title: info.title || null,
  });
}

// --- Model / reasoning-effort persistence -----------------------------------
// Two layers, both in localStorage:
//   MODEL_KEY   — last model+variant the user picked, used as the seed for new
//                 sessions and on a cold load before any session is opened.
//   SESSION_KEY — { [sessionID]: { providerID, modelID, variant } }, so each
//                 chat keeps the model it was last used with.
const MODEL_KEY = "oc.model";
const SESSION_MODEL_KEY = "oc.sessionModels";

// Reasoning effort defaults to "low" (no provider-default option in the UI);
// models that don't offer "low" fall back to their first variant.
const DEFAULT_VARIANT = "low";

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — selection just won't persist */
  }
}

function modelInfo(model) {
  if (!model) return null;
  return (
    opencodeStore.availableModels.find(
      (m) => m.providerID === model.providerID && m.modelID === model.modelID
    ) || null
  );
}

// The variant to use for `model`, preferring `preferred` when the model offers it.
function resolveVariant(model, preferred) {
  const variants = modelInfo(model)?.variants || [];
  if (!variants.length) return "";
  if (preferred && variants.includes(preferred)) return preferred;
  if (variants.includes(DEFAULT_VARIANT)) return DEFAULT_VARIANT;
  return variants[0];
}

function persistSelection() {
  const m = opencodeStore.selectedModel;
  if (!m) return;
  const entry = { providerID: m.providerID, modelID: m.modelID, variant: opencodeStore.thinkingLevel };
  writeJSON(MODEL_KEY, entry);

  const sessionID = opencodeStore.activeSessionId;
  if (sessionID) {
    const map = readJSON(SESSION_MODEL_KEY, {}) || {};
    map[sessionID] = entry;
    writeJSON(SESSION_MODEL_KEY, map);
  }
}

// Apply a stored { providerID, modelID, variant } entry if that model still
// exists in the catalog. Returns true when it was applied.
function applyStoredSelection(entry) {
  if (!entry || !modelInfo(entry)) return false;
  opencodeStore.selectedModel = { providerID: entry.providerID, modelID: entry.modelID };
  opencodeStore.thinkingLevel = resolveVariant(entry, entry.variant);
  return true;
}

// Restore the model this session was last used with (falling back to the
// global last-used model), without pushing it back to the server — the session
// already has it, and `session.model.selected` will correct us if not.
export function restoreSessionModel(sessionID) {
  if (!opencodeStore.availableModels.length) return;
  const map = readJSON(SESSION_MODEL_KEY, {}) || {};
  if (applyStoredSelection(map[sessionID])) return;
  applyStoredSelection(readJSON(MODEL_KEY, null));
}

// --- Per-session agent activity ---------------------------------------------
// The sidebar's live status dot. Two states worth showing:
//   running  — a turn is in flight for that session (amber pulse)
//   unread   — the turn ended while the user was somewhere else (green)
// Both are tracked for every session the event stream mentions, because the
// interesting case is precisely the session you are NOT looking at. `unread`
// is persisted so a page reload doesn't quietly drop "this one answered you".
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

// Every way a turn can stop. The three execution.* spellings and session.idle
// are all handled in the switch below for the same reason — different builds
// settle a turn with different ones.
const RUN_ENDED_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.completed",
  "session.execution.failed",
  "session.error",
  "session.idle",
]);

function activityRecord(sessionID) {
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

function setUnread(sessionID, unread) {
  const rec = activityRecord(sessionID);
  if (rec.unread === unread) return;
  rec.unread = unread;
  writeJSON(
    UNREAD_KEY,
    Object.keys(opencodeStore.sessionActivity).filter((id) => opencodeStore.sessionActivity[id].unread)
  );
}

function restoreUnread() {
  const ids = readJSON(UNREAD_KEY, []);
  if (!Array.isArray(ids)) return;
  for (const id of ids) activityRecord(id).unread = true;
}

// Mark a session as running from our own side, for the window between the
// POST and the first event coming back.
function markRunning(sessionID) {
  if (!sessionID) return;
  const rec = activityRecord(sessionID);
  rec.running = true;
  rec.updatedAt = Date.now();
}

// Fold one raw event into the activity map. Called for every event, BEFORE the
// active-session/child routing in handleServerEvent — that routing drops
// events for sessions that aren't in view, which is exactly the traffic this
// needs to see.
function trackSessionActivity(type, sessionID) {
  if (RUN_ACTIVE_EVENTS.has(type)) {
    markRunning(sessionID);
    // Amber outranks green: a session that started working again has nothing
    // stale left to read.
    setUnread(sessionID, false);
    return;
  }
  if (!RUN_ENDED_EVENTS.has(type)) return;

  const rec = activityRecord(sessionID);
  const wasRunning = rec.running;
  rec.running = false;
  rec.updatedAt = Date.now();
  // Green means "it finished while you were elsewhere". Finishing in the chat
  // you're actually reading is just finishing — and a sub-agent finishing is
  // reported on its card inside the parent turn, not as mail waiting for you.
  const isChild = !!opencodeStore.childSessions[sessionID];
  if (wasRunning && !isChild && sessionID !== opencodeStore.activeSessionId) {
    setUnread(sessionID, true);
  }
}

// Unwrap the opencode2 `{ data: [...] }` list envelope (tolerates a bare array/object too).
function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

// Unread dots survive a reload; running state does not (nothing to ask the
// server for — the stream re-establishes it within a turn's first event).
restoreUnread();

// Initialize connection & metadata from the opencode2 server
export async function initOpenCode() {
  try {
    const healthRes = await fetch(`${apiBase()}/health`, { headers: authHeaders() });
    opencodeStore.connected = healthRes.ok;
  } catch (err) {
    opencodeStore.connected = false;
    opencodeStore.error = `Failed to reach opencode server at ${apiBase()}/health`;
  }

  await Promise.all([loadModels(), loadAgents(), loadCommands(), loadSkills()]);
  setupEventStream();
}

// Variant lists arrive as arrays of names (or {id/name} objects) on live
// servers; tolerate a keyed-object shape too. Returns an array of name strings.
function normalizeVariants(variants) {
  if (Array.isArray(variants)) {
    return variants
      .map((v) => (typeof v === "string" ? v : (v && (v.id || v.name)) || ""))
      .filter(Boolean);
  }
  if (variants && typeof variants === "object") return Object.keys(variants);
  return [];
}

// Fetch the flat model catalog (GET /api/model -> { data: Model.Info[] }) for the picker.
export async function loadModels() {
  try {
    const res = await fetch(`${apiBase()}/model`, { headers: authHeaders() });
    if (res.ok) {
      const models = unwrap(await res.json());
      // Hide the built-in "opencode" provider — only show the user's own
      // connected providers.
      opencodeStore.availableModels = models
        .filter((m) => m.providerID !== "opencode")
        .map((m) => ({
        providerID: m.providerID,
        modelID: m.id,
        label: m.name || `${m.providerID}/${m.id}`,
        contextLimit: m.limit && m.limit.context,
        // Variant names (reasoning-effort presets) if this server's Model.Info
        // carries them. Live servers return an array (of names or {id/name}
        // objects); tolerate a keyed object too.
        variants: normalizeVariants(m.variants),
      }));

      if (!opencodeStore.selectedModel && opencodeStore.availableModels.length > 0) {
        // Prefer the last model the user picked; otherwise the first in the catalog.
        if (!applyStoredSelection(readJSON(MODEL_KEY, null))) {
          const first = opencodeStore.availableModels[0];
          opencodeStore.selectedModel = { providerID: first.providerID, modelID: first.modelID };
        }
      }
      // Catalogs load after a session may already be active, and variants are
      // only knowable once the catalog is here.
      if (opencodeStore.activeSessionId) restoreSessionModel(opencodeStore.activeSessionId);
      opencodeStore.thinkingLevel = resolveVariant(
        opencodeStore.selectedModel,
        opencodeStore.thinkingLevel
      );
    }
  } catch (err) {
    console.warn("Could not load opencode models:", err);
  }
}

// Fetch available agents (GET /api/agent -> { data: Agent.Info[] }); hide subagents/hidden.
export async function loadAgents() {
  try {
    const res = await fetch(`${apiBase()}/agent`, { headers: authHeaders() });
    if (res.ok) {
      const agents = unwrap(await res.json());
      opencodeStore.availableAgents = agents.filter((a) => a.mode !== "subagent" && !a.hidden);
      opencodeStore.subagentRoster = agents.filter((a) => a.mode === "subagent");

      // Agents are addressed by `id` ("build"); `name` is the display label ("Build").
      // Sending the name yields `Agent not found: "Build"` on the server.
      const ids = opencodeStore.availableAgents.map((a) => a.id || a.name);
      if (!ids.includes(opencodeStore.selectedAgent)) {
        const primary = opencodeStore.availableAgents.find((a) => a.mode === "primary");
        opencodeStore.selectedAgent = (primary && (primary.id || primary.name)) || ids[0] || "build";
      }
    }
  } catch (err) {
    console.warn("Could not load opencode agents:", err);
  }
}

// Fetch available slash commands (GET /api/command -> { data: [...] }).
export async function loadCommands() {
  try {
    const res = await fetch(`${apiBase()}/command`, { headers: authHeaders() });
    if (res.ok) {
      opencodeStore.commands = unwrap(await res.json());
    }
  } catch (err) {
    console.warn("Could not load opencode commands:", err);
  }
}

// Fetch available skills (GET /api/skill -> { data: [...] }); optional —
// older servers without the route just leave the list empty.
export async function loadSkills() {
  try {
    const res = await fetch(`${apiBase()}/skill`, { headers: authHeaders() });
    if (res.ok) {
      opencodeStore.skills = unwrap(await res.json());
    }
  } catch (err) {
    console.warn("Could not load opencode skills:", err);
  }
}

// Run a slash command. The V2 HttpApi has no server-side command dispatch
// route, so this just sends the raw "/name args" text as a plain prompt —
// the agent parses the leading slash itself.
export async function runCommand(name, args) {
  const rawText = `/${name}${args ? ` ${args}` : ""}`;
  await sendPrompt(rawText);
}

// Subscribe to the event stream (fetch-based, so we can attach an Authorization header —
// the browser's native EventSource cannot). opencode2 events are { id, type, data }.
let eventAbort = null;

function setupEventStream() {
  if (eventAbort) return;
  eventAbort = new AbortController();

  fetchEventSource(`${apiBase()}/event`, {
    headers: authHeaders(),
    signal: eventAbort.signal,
    openWhenHidden: true,
    onopen: async (res) => {
      if (res.ok) {
        opencodeStore.connected = true;
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

// Find or create a message shell by id in `list` — the active session's
// transcript, or a sub-agent child's own transcript.
function findOrCreateMessage(list, messageID, role) {
  let msg = list.find((m) => m.id === messageID);
  if (!msg) {
    msg = { id: messageID, role: role || "assistant", parts: [], text: "", createdAt: null };
    list.push(msg);
  }
  return msg;
}

// Recompute the convenience `text` field from a message's non-synthetic text parts
function recomputeText(msg) {
  msg.text = msg.parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text || "")
    .join("");
}

// Update sessionStats (kept in the exact shape UsagePopover expects) from an assistant message
function updateSessionStats(info) {
  const tokens = info.tokens || {};
  const input = tokens.input || 0;
  const output = tokens.output || 0;
  const cache = tokens.cache || {};

  opencodeStore.sessionStats.tokens = {
    input,
    output,
    total: input + output,
    cacheRead: cache.read || 0,
    cacheWrite: cache.write || 0,
  };
  opencodeStore.sessionStats.cost = opencodeStore.messages
    .filter((m) => m.role === "assistant")
    .reduce((sum, m) => sum + (m.cost || 0), 0);

  const model = opencodeStore.availableModels.find(
    (m) => m.providerID === info.providerID && m.modelID === info.modelID
  );
  setDerivedContextPercent(input + output, model && model.contextLimit);
}

// The local estimate: used tokens over the model catalog's context limit.
// Yields to the server's own accounting once that has answered.
function setDerivedContextPercent(used, contextLimit) {
  const usage = opencodeStore.sessionStats.contextUsage;
  if (usage.fromServer) return;
  usage.used = used;
  usage.limit = contextLimit || null;
  usage.percent = contextLimit ? (used / contextLimit) * 100 : 0;
}

// GET /api/session/{id}/context — the context/token accounting the server
// actually applies, which is the number that decides when a session gets
// compacted. The response shape is not pinned down in the spec beyond being
// an object of counts, so read it tolerantly and only take it over the local
// estimate when it yields a usable pair (or an outright percentage).
export async function refreshSessionContext(sessionID) {
  const id = sessionID || opencodeStore.activeSessionId;
  if (!id) return;
  const payload = await fetchJSON(`${apiBase()}/session/${id}/context`);
  if (!payload) return;
  // A late response for a session the user has already navigated away from
  // must not land on the session now in view.
  if (id !== opencodeStore.activeSessionId) return;

  const d = payload.data || payload;
  const tokens = d.tokens || {};
  const tokenSum =
    tokens.input != null || tokens.output != null
      ? (num(tokens.input) || 0) + (num(tokens.output) || 0)
      : null;
  const used = num(d.used) ?? num(d.total) ?? tokenSum;
  const limit = num(d.limit) ?? num(d.contextLimit) ?? num(d.max);
  const percent = num(d.percent) ?? (used != null && limit ? (used / limit) * 100 : null);
  if (percent == null) return;

  opencodeStore.sessionStats.contextUsage = {
    percent,
    used,
    limit,
    fromServer: true,
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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

// A turn emits several session.usage.updated events; coalesce them into one
// context read shortly after the last.
let contextTimer = null;
function scheduleContextRefresh() {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    contextTimer = null;
    refreshSessionContext();
  }, 750);
}

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

// Streaming events carry the assistant message id but no role/time, so seed those.
function assistantMessageFor(list, props) {
  const msg = findOrCreateMessage(list, props.assistantMessageID, "assistant");
  msg.role = "assistant";
  if (!msg.createdAt) msg.createdAt = Date.now();
  return msg;
}

// session.usage.updated carries session-wide totals directly, so set them rather
// than re-deriving from per-message tokens.
function applyUsageUpdate(props) {
  const tokens = props.tokens || {};
  const input = tokens.input || 0;
  const output = tokens.output || 0;
  const cache = tokens.cache || {};

  opencodeStore.sessionStats.tokens = {
    input,
    output,
    total: input + output,
    cacheRead: cache.read || 0,
    cacheWrite: cache.write || 0,
  };
  if (typeof props.cost === "number") opencodeStore.sessionStats.cost = props.cost;

  const selected = opencodeStore.selectedModel;
  const model = selected
    ? opencodeStore.availableModels.find(
        (m) => m.providerID === selected.providerID && m.modelID === selected.modelID
      )
    : null;
  setDerivedContextPercent(input + output, model && model.contextLimit);
}

// Process real-time events. Envelope is { id, type, data }; payload lives on `data`.
//
// Event vocabulary verified by tapping GET /api/event on a live server. This build
// does NOT emit the classic Part model (message.updated / message.part.updated /
// session.idle) — those never fire, which is why assistant replies used to never
// render and the streaming flag never cleared. What it actually emits per prompt:
//   session.input.admitted -> session.execution.started -> session.input.promoted
//   -> session.step.started
//      -> session.reasoning.started / .delta / .ended     (ordinal-keyed)
//      -> session.tool.input.started / .delta / .ended    (callID-keyed)
//      -> session.tool.called -> [.progress] -> .success
//      -> session.text.started / .delta / .ended          (ordinal-keyed)
//   -> session.step.ended -> session.usage.updated -> session.execution.succeeded
function handleServerEvent(event) {
  if (!event || !event.type) return;
  const { type, data } = event;
  const props = data || {};

  // Interactive gates are dispatched BEFORE the session router below, because
  // they must never be dropped: they carry their own sessionID for the reply
  // and they block a run until answered, so a gate raised by a sub-agent (or
  // by a session we aren't currently viewing) still has to reach the user.
  //
  // permission.v2.asked / .replied — the permission store enqueues asks and
  // clears replies with the right shape.
  if (type === "permission.v2.asked" || type === "permission.v2.replied") {
    handlePermissionEvent(event);
    return;
  }

  // question.v2.* — structured mid-execution asks, same contract.
  if (type.startsWith("question.v2.")) {
    handleQuestionEvent(event);
    return;
  }

  const eventSessionId =
    (props.part && props.part.sessionID) ||
    (props.info && props.info.sessionID) ||
    props.sessionID;

  // Sidebar status first: every session's dot is driven from here, so this has
  // to happen before the routing below drops events for sessions that aren't
  // the one on screen.
  if (eventSessionId) trackSessionActivity(type, eventSessionId);

  // A sub-agent's child session emits the SAME event vocabulary under its own
  // sessionID, so events are routed rather than filtered: the active session
  // drives the main transcript, a known child drives its own, and anything
  // else is dropped. `child` being non-null is what makes the rest of this
  // function skip session-wide state (streaming flag, model selection, usage)
  // — that state belongs to the session in view, not to a sub-agent.
  let child = null;
  let messages = opencodeStore.messages;
  if (eventSessionId && opencodeStore.activeSessionId && eventSessionId !== opencodeStore.activeSessionId) {
    child = opencodeStore.childSessions[eventSessionId] || adoptChild(type, props, eventSessionId);
    if (!child) return;
    messages = child.messages;
  }

  switch (type) {
    case "server.connected": {
      opencodeStore.connected = true;
      break;
    }

    case "session.execution.started": {
      if (child) {
        child.status = "running";
        child.startedAt = child.startedAt || Date.now();
      } else if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = true;
      }
      break;
    }

    case "session.model.selected": {
      // Selection is per-session state, so ignore events for other sessions.
      if (props.sessionID && props.sessionID !== opencodeStore.activeSessionId) break;
      if (props.providerID && props.modelID) {
        opencodeStore.selectedModel = { providerID: props.providerID, modelID: props.modelID };
      }
      opencodeStore.thinkingLevel = resolveVariant(
        opencodeStore.selectedModel,
        props.variant || opencodeStore.thinkingLevel
      );
      persistSelection();
      break;
    }

    // Explicitly acknowledged so a maintainer scanning this switch sees it
    // was considered, not missed — no state change today. The user message is
    // already appended optimistically by sendPrompt, and session.execution.succeeded
    // reconciles against the server, so re-adding it here would duplicate it.
    case "session.input.admitted":
    case "session.input.promoted":
    case "shell.created":
    case "shell.exited": {
      break;
    }

    case "session.step.started": {
      const msg = assistantMessageFor(messages, props);
      if (props.model) {
        msg.providerID = props.model.providerID;
        msg.modelID = props.model.id;
        // The dispatch tool call doesn't say which model the sub-agent got;
        // its first step does.
        if (child && !child.model) child.model = props.model;
      }
      if (!child) opencodeStore.isStreaming = true;
      break;
    }

    case "session.reasoning.started":
    case "session.text.started": {
      const kind = type === "session.reasoning.started" ? "reasoning" : "text";
      const msg = assistantMessageFor(messages, props);
      upsertPart(msg, `${kind}:${props.ordinal}`, { type: kind, text: "" });
      if (!child) opencodeStore.isStreaming = true;
      break;
    }

    case "session.reasoning.delta":
    case "session.text.delta": {
      const kind = type === "session.reasoning.delta" ? "reasoning" : "text";
      const msg = assistantMessageFor(messages, props);
      appendPartText(msg, `${kind}:${props.ordinal}`, kind, props.delta);
      if (kind === "text") recomputeText(msg);
      if (!child) opencodeStore.isStreaming = true;
      break;
    }

    // `.ended` carries the authoritative full text, so replace rather than append —
    // this also repairs any delta that was missed.
    case "session.reasoning.ended":
    case "session.text.ended": {
      const kind = type === "session.reasoning.ended" ? "reasoning" : "text";
      const msg = assistantMessageFor(messages, props);
      upsertPart(msg, `${kind}:${props.ordinal}`, {
        type: kind,
        text: props.text || "",
        phase: props.state && props.state.phase,
      });
      if (kind === "text") recomputeText(msg);
      break;
    }

    case "session.tool.input.started": {
      const msg = assistantMessageFor(messages, props);
      upsertPart(msg, `tool:${props.callID}`, {
        type: "tool",
        tool: props.name,
        callID: props.callID,
        state: { status: "pending" },
      });
      break;
    }

    case "session.tool.input.ended": {
      const msg = assistantMessageFor(messages, props);
      // `text` is the raw JSON argument string; parse for display when it's valid.
      let input;
      try {
        input = JSON.parse(props.text);
      } catch {
        input = props.text;
      }
      upsertPart(msg, `tool:${props.callID}`, { input });
      break;
    }

    case "session.tool.called": {
      const msg = assistantMessageFor(messages, props);
      upsertPart(msg, `tool:${props.callID}`, {
        type: "tool",
        callID: props.callID,
        input: props.input,
        state: { status: "running" },
      });
      break;
    }

    case "session.tool.progress": {
      const msg = assistantMessageFor(messages, props);
      upsertPart(msg, `tool:${props.callID}`, { state: { status: "running" } });
      // For a `subagent` call this is the live link between the dispatching
      // tool call and the child session it spawned — the only place it arrives
      // while the run is in flight. Note the doubled nesting: the event's own
      // `metadata` wraps the tool's `metadata`.
      const meta = props.metadata && props.metadata.metadata;
      if (meta && meta.sessionID) {
        upsertChild(meta.sessionID, {
          callID: props.callID,
          parentSessionID: props.sessionID,
          status: meta.status || "running",
        });
      }
      break;
    }

    case "session.tool.success": {
      const msg = assistantMessageFor(messages, props);
      upsertPart(msg, `tool:${props.callID}`, {
        state: { status: "completed", output: toolContentText(props.content) },
      });
      // The child's own execution.succeeded may never arrive if we connected
      // mid-run, so settle it from the parent's side too.
      const settled = opencodeStore.callChildIndex[props.callID];
      if (settled && opencodeStore.childSessions[settled]) {
        const c = opencodeStore.childSessions[settled];
        if (c.status === "running") {
          c.status = "completed";
          c.endedAt = c.endedAt || Date.now();
        }
      }
      break;
    }

    // Error-event names for a failed tool call are unverified against a live server
    // (no failing call was captured); both spellings are handled so whichever the
    // server emits surfaces the error instead of leaving the call stuck "running".
    case "session.tool.error":
    case "session.tool.failed": {
      const msg = assistantMessageFor(messages, props);
      const err = props.error;
      upsertPart(msg, `tool:${props.callID}`, {
        state: {
          status: "error",
          error: (err && (err.message || err.type)) || props.message || "tool call failed",
        },
      });
      break;
    }

    case "session.step.ended": {
      const msg = assistantMessageFor(messages, props);
      msg.tokens = props.tokens;
      msg.cost = props.cost;
      break;
    }

    // Parent and child are metered separately — each emits its own
    // session.usage.updated — so child totals go on the child record and are
    // additive with the session's, never a double-count of it.
    case "session.usage.updated": {
      if (child) {
        child.tokens = props.tokens || child.tokens;
      } else {
        applyUsageUpdate(props);
        // Usage moving is the only signal that context has moved, so this is
        // where server truth is re-read. Debounced — a turn emits several.
        scheduleContextRefresh();
      }
      break;
    }

    case "session.execution.succeeded": {
      if (child) {
        child.status = "completed";
        child.endedAt = Date.now();
      } else if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = false;
        // Reconcile with server truth (drops optimistic artifacts, applies final content).
        refreshActiveMessages();
      }
      break;
    }

    // Credentials changed — on this server or another client. Reload the
    // integration list AND the model catalog: connecting a provider is
    // exactly what makes new models appear, and stale pickers after adding a
    // key were the whole reason this needed a manual reload.
    case "integration.updated":
    case "integration.connection.updated": {
      scheduleIntegrationRefresh();
      break;
    }

    // No state today — PTY runner uses one-shot lifecycle (see pty.js).
    case "pty.created":
    case "pty.exited":
    case "pty.deleted": {
      break;
    }

    case "message.updated": {
      const info = props.info;
      if (!info) break;
      const msg = findOrCreateMessage(messages, info.id, info.role);
      msg.role = info.role;
      msg.tokens = info.tokens;
      msg.cost = info.cost;
      msg.error = info.error || null;
      msg.createdAt = (info.time && info.time.created) || msg.createdAt || null;

      if (info.role === "assistant" && !child) {
        updateSessionStats(info);
      }
      break;
    }

    case "message.part.updated": {
      // SSE parts use the classic Part shape (text/reasoning/tool{tool,state}/file),
      // which MessageView renders directly. Upsert by part id.
      const part = props.part;
      if (!part) break;
      if (!child) opencodeStore.isStreaming = true;
      const msg = findOrCreateMessage(messages, part.messageID);
      const idx = msg.parts.findIndex((p) => p.id === part.id);
      if (idx >= 0) {
        msg.parts[idx] = part;
      } else {
        msg.parts.push(part);
      }
      recomputeText(msg);
      break;
    }

    case "message.part.removed": {
      const messageID = props.messageID || (props.part && props.part.messageID);
      const partID = props.partID || (props.part && props.part.id);
      const msg = messages.find((m) => m.id === messageID);
      if (msg) {
        msg.parts = msg.parts.filter((p) => p.id !== partID);
        recomputeText(msg);
      }
      break;
    }

    case "message.removed": {
      const messageID = props.messageID || (props.info && props.info.id);
      // Splice rather than reassign — `messages` may be a child's own array.
      const at = messages.findIndex((m) => m.id === messageID);
      if (at >= 0) messages.splice(at, 1);
      break;
    }

    case "session.idle": {
      if (child) {
        child.status = "completed";
        child.endedAt = Date.now();
      } else if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = false;
        // Reconcile with server truth (drops optimistic artifacts, applies final content).
        refreshActiveMessages();
      }
      break;
    }

    // Live oc2 servers emit a session.execution.* lifecycle around each prompt
    // rather than only session.idle/session.error.
    case "session.execution.completed": {
      if (child) {
        child.status = "completed";
        child.endedAt = Date.now();
      } else if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = false;
        refreshActiveMessages();
      }
      break;
    }

    // A sub-agent failing is reported on its card, not as a session-wide error
    // banner — the parent turn is still alive and will handle the tool error.
    case "session.execution.failed": {
      const err = props.error;
      const message = (err && err.message) || (err && err.type) || "Execution failed";
      if (child) {
        child.status = "error";
        child.error = message;
        child.endedAt = Date.now();
      } else {
        opencodeStore.error = message;
        opencodeStore.isStreaming = false;
      }
      break;
    }

    case "session.error": {
      const err = props.error;
      const message =
        (err && (err.data && err.data.message)) || (err && err.name) || "Session error";
      if (child) {
        child.status = "error";
        child.error = message;
        child.endedAt = Date.now();
      } else {
        opencodeStore.error = message;
        opencodeStore.isStreaming = false;
      }
      break;
    }
  }
}

// Load message history for a specific session
export async function connectToSession(sessionID) {
  if (!sessionID) return;
  opencodeStore.activeSessionId = sessionID;
  // Opening a chat reads it — and if its agent is still mid-turn, come back up
  // streaming rather than pretending the run ended when we navigated away.
  setUnread(sessionID, false);
  opencodeStore.isStreaming = !!(opencodeStore.sessionActivity[sessionID] || {}).running;
  // Sub-agent state belongs to the session being left, not the one being opened.
  opencodeStore.childSessions = {};
  opencodeStore.callChildIndex = {};
  opencodeStore.revertStaged = null;
  // Context accounting is per-session; carrying the previous session's
  // server-sourced figure over would show a stale number as authoritative.
  opencodeStore.sessionStats.contextUsage = { percent: 0, used: null, limit: null, fromServer: false };
  restoreSessionModel(sessionID);

  await refreshActiveMessages();
  await Promise.all([backfillChildSessions(), refreshSessionContext(sessionID)]);
}

// Rebuild sub-agent cards for a restored transcript. Every stored `subagent`
// tool part carries its child session id on state.metadata, so this needs no
// parentID scan over the session list — each call points straight at its child.
async function backfillChildSessions() {
  const parentID = opencodeStore.activeSessionId;
  const dispatches = [];
  for (const msg of opencodeStore.messages) {
    for (const part of msg.parts || []) {
      if (!isSubagentPart(part)) continue;
      const meta = part.state && part.state.metadata;
      if (meta && meta.sessionID) {
        dispatches.push({ childID: meta.sessionID, callID: part.callID, meta, part });
      }
    }
  }

  await Promise.all(
    dispatches.map(async ({ childID, callID, meta, part }) => {
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
        fetchJSON(`${apiBase()}/session/${childID}`),
        fetchJSON(`${apiBase()}/session/${childID}/message`),
      ]);
      if (info) {
        const d = info.data || info;
        child.agent = d.agent || child.agent;
        child.model = d.model || child.model;
        child.title = d.title || child.title;
        child.tokens = d.tokens || child.tokens;
        child.startedAt = (d.time && d.time.created) || child.startedAt;
      }
      if (list) {
        child.messages = unwrap(list)
          .map(normalizeRestMessage)
          .filter(Boolean)
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      }
    })
  );
}

// GET helper that yields null instead of throwing — a sub-agent whose session
// has been pruned server-side must not break the whole transcript load.
async function fetchJSON(url) {
  try {
    const res = await fetch(url, { headers: authHeaders() });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function refreshActiveMessages() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;

  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/message`, { headers: authHeaders() });
    if (res.ok) {
      const list = unwrap(await res.json());
      // This endpoint returns newest-first; the transcript renders top-to-bottom
      // oldest-first, so order by creation time ascending (sort is stable, so
      // anything without a timestamp keeps its relative position).
      opencodeStore.messages = list
        .map(normalizeRestMessage)
        .filter(Boolean)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      opencodeStore.forkMessages = opencodeStore.messages
        .filter((m) => m.role === "user")
        .map((m, idx) => ({ entryId: m.id || idx, text: m.text }));
    }
  } catch (err) {
    console.error(`Failed to fetch messages for session ${sessionID}:`, err);
  }
}

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

function toolContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && c.type === "text" ? c.text : (c && c.text) || ""))
    .filter(Boolean)
    .join("\n");
}

// Send user prompt (POST /api/session/:id/prompt). Body is a FLAT PromptInput —
// `{ text, files?, agents?, delivery?, resume? }` with `text` required — per the
// live openapi.json (a wrapped `{ prompt: {...} }` 400s with "Missing key at [text]"
// on current builds; older builds wanted the wrapper, so re-verify on upgrade).
// `files` are composer attachments (paste/drop/picker), each `{ filename, mime, url }`
// where `url` is a `data:<mime>;base64,...` URL. The wire shape is different and strict:
// `PromptInput.FileAttachment` is `{uri, name?, description?, mention?}` with
// `additionalProperties: false`, so sending `{filename, mime, url}` 400s. The server
// parses the data URI and stores it as `{data, mime, source: {type: "inline"}, name}`.
export async function sendPrompt(text, files) {
  const attachments = Array.isArray(files) ? files : [];
  const promptText = (text || "").trim();
  if ((!promptText && !attachments.length) || !opencodeStore.activeSessionId) return;
  const sessionID = opencodeStore.activeSessionId;

  opencodeStore.draft = "";

  const userMsgId = `user-${Date.now()}`;
  opencodeStore.messages.push({
    id: userMsgId,
    role: "user",
    parts: [
      ...(promptText ? [{ type: "text", text: promptText }] : []),
      ...attachments.map((f, i) => ({ id: `${userMsgId}-f${i}`, type: "file", ...f })),
    ],
    text: promptText,
  });

  opencodeStore.forkMessages.push({ entryId: userMsgId, text: promptText });
  opencodeStore.isStreaming = true;
  markRunning(sessionID);

  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(
        attachments.length
          ? {
              text: promptText,
              files: attachments.map((f) => ({ uri: f.url, name: f.filename })),
            }
          : { text: promptText }
      ),
    });

    if (!res.ok) {
      throw new Error(`Failed to send prompt (${res.status})`);
    }
    // Do NOT append assistant text here — the SSE stream drives assistant rendering.
  } catch (err) {
    opencodeStore.isStreaming = false;
    activityRecord(sessionID).running = false;
    opencodeStore.error = err.message;
    console.error("Error sending prompt to opencode:", err);
  }
}

// --- Revert -----------------------------------------------------------------
// V2 has no session fork, and `revert/*` is the closest thing to "go back to
// before message X": stage a revert to preview it, then commit to keep it or
// clear to abandon it. The staged state lives on the session record's
// `revert` field server-side, mirrored here so the banner can offer the two
// exits.
//
// ⚠️ The stage BODY is unverified — the spec names the route but the request
// schema was never captured. It is built in one place for that reason.
export async function stageRevert(messageID) {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID || !messageID) return;
  const ok = await postRevert(sessionID, "stage", { messageID });
  if (ok) {
    opencodeStore.revertStaged = { messageID };
    await refreshActiveMessages();
  }
}

// Make the staged revert permanent.
export async function commitRevert() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  if (await postRevert(sessionID, "commit", {})) {
    opencodeStore.revertStaged = null;
    await refreshActiveMessages();
  }
}

// Abandon the staged revert and restore the full transcript.
export async function clearRevert() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  if (await postRevert(sessionID, "clear", {})) {
    opencodeStore.revertStaged = null;
    await refreshActiveMessages();
  }
}

async function postRevert(sessionID, action, body) {
  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/revert/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;
    let message = `Revert ${action} failed (${res.status})`;
    try {
      const payload = await res.json();
      if (payload && payload.message) message = payload.message;
    } catch {
      /* non-JSON error body — the status line is enough */
    }
    opencodeStore.error = message;
    return false;
  } catch (err) {
    opencodeStore.error = err.message || `Revert ${action} failed`;
    return false;
  }
}

// Interrupt active running execution (POST /api/session/:id/interrupt).
export async function abortSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;

  try {
    await fetch(`${apiBase()}/session/${sessionID}/interrupt`, { method: "POST", headers: authHeaders() });
  } catch (err) {
    console.error("Failed to interrupt session:", err);
  } finally {
    opencodeStore.isStreaming = false;
    activityRecord(sessionID).running = false;
  }
}

// Select the model. Stored as { providerID, modelID }; switched on the active session via
// POST /api/session/:id/model { model: { id, providerID, variant? } } (Model.Ref).
export async function setModel(model) {
  opencodeStore.selectedModel = model;
  // Carry the current effort across if the new model offers it, else fall back
  // to the default ("low").
  opencodeStore.thinkingLevel = resolveVariant(model, opencodeStore.thinkingLevel);
  persistSelection();
  await pushSessionModel();
}

// Select the reasoning-effort variant for the current model.
export async function setThinkingLevel(level) {
  opencodeStore.thinkingLevel = resolveVariant(opencodeStore.selectedModel, level);
  persistSelection();
  await pushSessionModel();
}

async function pushSessionModel() {
  const sessionID = opencodeStore.activeSessionId;
  const modelRef = selectedModelRef();
  if (!sessionID || !modelRef) return;
  try {
    await fetch(`${apiBase()}/session/${sessionID}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ model: modelRef }),
    });
  } catch (e) {
    console.warn("Failed to switch session model:", e);
  }
}

// Select the agent. Switched on the active session via POST /api/session/:id/agent { agent }.
export async function setAgent(agentName) {
  opencodeStore.selectedAgent = agentName;
  const sessionID = opencodeStore.activeSessionId;
  if (sessionID && agentName) {
    try {
      await fetch(`${apiBase()}/session/${sessionID}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ agent: agentName }),
      });
    } catch (e) {
      console.warn("Failed to switch session agent:", e);
    }
  }
}

// Build a Model.Ref from the current selection (for session creation / model switch).
export function selectedModelRef() {
  const m = opencodeStore.selectedModel;
  if (!m || !m.modelID || !m.providerID) return undefined;
  const ref = { id: m.modelID, providerID: m.providerID };
  if (opencodeStore.thinkingLevel) ref.variant = opencodeStore.thinkingLevel;
  return ref;
}

// Compact the active session's context (POST /api/session/:id/compact),
// then reconcile the transcript with server truth. In current builds this
// may return 503 "Session compact is not available yet" — surface that as
// an error banner rather than swallowing it silently.
export async function compactSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/compact`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (res.ok) {
      await refreshActiveMessages();
      return;
    }
    let message = `Compact failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.message) message = body.message;
    } catch {}
    opencodeStore.error = message;
  } catch (err) {
    opencodeStore.error = err.message || "Failed to compact session";
  }
}

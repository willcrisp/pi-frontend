// OpenCode2 Client Store
// Direct HTTP REST + SSE client for the opencode2 "HttpApi" surface (routes under /api,
// list responses wrapped in { data }). Reached through the dev proxy via apiBase().
import { reactive } from "vue";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { apiBase, authHeaders } from "./ssh.js";
import { handlePermissionEvent } from "./permission.js";

export const opencodeStore = reactive({
  connected: false,
  activeSessionId: null,
  activeSession: null,
  messages: [],
  forkMessages: [],
  isStreaming: false,
  availableModels: [], // [{ providerID, modelID, label, contextLimit, variants }]
  selectedModel: null, // { providerID, modelID }
  thinkingLevel: "", // selected model variant name ("" = provider default)
  availableAgents: [],
  selectedAgent: "build",
  draft: "",
  error: null,
  sessionStats: {
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextUsage: { percent: 0 },
  },
  toolResults: {},
  commands: [],
  skills: [],
});

// Helper function for subagent details compatibility
export function subagentDetails(result) {
  if (!result) return null;
  return result.details || null;
}

// Unwrap the opencode2 `{ data: [...] }` list envelope (tolerates a bare array/object too).
function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

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
        const first = opencodeStore.availableModels[0];
        opencodeStore.selectedModel = { providerID: first.providerID, modelID: first.modelID };
      }
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

// Find or create a message shell in the active message list by id
function findOrCreateMessage(messageID, role) {
  let msg = opencodeStore.messages.find((m) => m.id === messageID);
  if (!msg) {
    msg = { id: messageID, role: role || "assistant", parts: [], text: "", createdAt: null };
    opencodeStore.messages.push(msg);
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
  const contextLimit = model && model.contextLimit;
  opencodeStore.sessionStats.contextUsage.percent = contextLimit
    ? ((input + output) / contextLimit) * 100
    : 0;
}

// Process real-time events. Envelope is { id, type, data }; payload lives on `data`.
// Streaming uses the classic Part model (message.updated { info }, message.part.updated { part }).
function handleServerEvent(event) {
  if (!event || !event.type) return;
  const { type, data } = event;
  const props = data || {};

  const eventSessionId =
    (props.part && props.part.sessionID) ||
    (props.info && props.info.sessionID) ||
    props.sessionID;

  if (
    eventSessionId &&
    opencodeStore.activeSessionId &&
    eventSessionId !== opencodeStore.activeSessionId
  ) {
    return;
  }

  // permission.v2.asked / .replied — routed to the permission store's own
  // handler so it can enqueue asks and clear replies with the right shape.
  if (type === "permission.v2.asked" || type === "permission.v2.replied") {
    handlePermissionEvent(event);
    return;
  }

  switch (type) {
    case "server.connected": {
      opencodeStore.connected = true;
      break;
    }

    case "session.execution.started": {
      if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = true;
      }
      break;
    }

    case "session.model.selected": {
      if (props.providerID && props.modelID) {
        opencodeStore.selectedModel = { providerID: props.providerID, modelID: props.modelID };
      }
      if (props.variant) opencodeStore.thinkingLevel = props.variant;
      break;
    }

    // Explicitly acknowledged so a maintainer scanning this switch sees it
    // was considered, not missed — no state change today.
    case "session.input.admitted": {
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
      const msg = findOrCreateMessage(info.id, info.role);
      msg.role = info.role;
      msg.tokens = info.tokens;
      msg.cost = info.cost;
      msg.error = info.error || null;
      msg.createdAt = (info.time && info.time.created) || msg.createdAt || null;

      if (info.role === "assistant") {
        updateSessionStats(info);
      }
      break;
    }

    case "message.part.updated": {
      // SSE parts use the classic Part shape (text/reasoning/tool{tool,state}/file),
      // which MessageView renders directly. Upsert by part id.
      const part = props.part;
      if (!part) break;
      opencodeStore.isStreaming = true;
      const msg = findOrCreateMessage(part.messageID);
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
      const msg = opencodeStore.messages.find((m) => m.id === messageID);
      if (msg) {
        msg.parts = msg.parts.filter((p) => p.id !== partID);
        recomputeText(msg);
      }
      break;
    }

    case "message.removed": {
      const messageID = props.messageID || (props.info && props.info.id);
      opencodeStore.messages = opencodeStore.messages.filter((m) => m.id !== messageID);
      break;
    }

    case "session.idle": {
      if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = false;
        // Reconcile with server truth (drops optimistic artifacts, applies final content).
        refreshActiveMessages();
      }
      break;
    }

    // Live oc2 servers emit a session.execution.* lifecycle around each prompt
    // rather than only session.idle/session.error.
    case "session.execution.completed": {
      if (!props.sessionID || props.sessionID === opencodeStore.activeSessionId) {
        opencodeStore.isStreaming = false;
        refreshActiveMessages();
      }
      break;
    }

    case "session.execution.failed": {
      const err = props.error;
      opencodeStore.error = (err && err.message) || (err && err.type) || "Execution failed";
      opencodeStore.isStreaming = false;
      break;
    }

    case "session.error": {
      const err = props.error;
      opencodeStore.error = (err && (err.data && err.data.message)) || (err && err.name) || "Session error";
      opencodeStore.isStreaming = false;
      break;
    }
  }
}

// Load message history for a specific session
export async function connectToSession(sessionID) {
  if (!sessionID) return;
  opencodeStore.activeSessionId = sessionID;
  opencodeStore.isStreaming = false;

  await refreshActiveMessages();
}

export async function refreshActiveMessages() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;

  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/message`, { headers: authHeaders() });
    if (res.ok) {
      const list = unwrap(await res.json());
      opencodeStore.messages = list.map(normalizeRestMessage).filter(Boolean);
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
    return { id: m.id, role: "user", parts: text ? [{ type: "text", text }] : [], text, createdAt };
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

// Map a REST assistant `content[]` item to a canonical part (matching the SSE Part shape
// that MessageView renders: text/reasoning/tool{tool,state:{status,output,error}}).
function normalizeContentItem(item) {
  if (!item || !item.type) return null;
  if (item.type === "text") return { type: "text", text: item.text || "" };
  if (item.type === "reasoning") return { type: "reasoning", text: item.text || "" };
  if (item.type === "tool") {
    return { type: "tool", tool: item.name, callID: item.id, state: normalizeRestToolState(item.state) };
  }
  return null;
}

function normalizeRestToolState(state) {
  if (!state) return { status: "pending" };
  const out = { status: state.status };
  if (state.status === "completed") out.output = toolContentText(state.content);
  else if (state.status === "error") out.error = (state.error && state.error.message) || "error";
  return out;
}

function toolContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && c.type === "text" ? c.text : (c && c.text) || ""))
    .filter(Boolean)
    .join("\n");
}

// Send user prompt (POST /api/session/:id/prompt { prompt: PromptInput }).
// Body wraps under `prompt` — a flat `{ text }` 400s with "Missing key at [prompt]".
export async function sendPrompt(text) {
  if (!text || !text.trim() || !opencodeStore.activeSessionId) return;
  const sessionID = opencodeStore.activeSessionId;

  const promptText = text.trim();
  opencodeStore.draft = "";

  const userMsgId = `user-${Date.now()}`;
  opencodeStore.messages.push({
    id: userMsgId,
    role: "user",
    parts: [{ type: "text", text: promptText }],
    text: promptText,
  });

  opencodeStore.forkMessages.push({ entryId: userMsgId, text: promptText });
  opencodeStore.isStreaming = true;

  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ prompt: { text: promptText } }),
    });

    if (!res.ok) {
      throw new Error(`Failed to send prompt (${res.status})`);
    }
    // Do NOT append assistant text here — the SSE stream drives assistant rendering.
  } catch (err) {
    opencodeStore.isStreaming = false;
    opencodeStore.error = err.message;
    console.error("Error sending prompt to opencode:", err);
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
  }
}

// Select the model. Stored as { providerID, modelID }; switched on the active session via
// POST /api/session/:id/model { model: { id, providerID, variant? } } (Model.Ref).
export async function setModel(model) {
  opencodeStore.selectedModel = model;
  // Reset the variant if the new model doesn't offer the current one.
  const info = opencodeStore.availableModels.find(
    (m) => model && m.providerID === model.providerID && m.modelID === model.modelID
  );
  if (info && !info.variants.includes(opencodeStore.thinkingLevel)) {
    opencodeStore.thinkingLevel = "";
  }
  await pushSessionModel();
}

// Select the reasoning-effort variant for the current model ("" = provider default).
export async function setThinkingLevel(level) {
  opencodeStore.thinkingLevel = level || "";
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

// Fork the active session from a given message (POST /api/session/:id/fork
// { messageID }); switches to the new session on success. Imports projects.js
// lazily — it imports this module, so a static import here would cycle.
// UNVERIFIED against /doc — see docs/opencode-api.md
export async function forkSession(messageID) {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID || !messageID) return;
  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ messageID }),
    });
    if (!res.ok) return;
    const body = await res.json();
    const newId = body && body.data ? body.data.id : body && body.id;
    if (!newId) return;
    const { fetchSessions, openSession } = await import("./projects.js");
    await fetchSessions();
    openSession(newId);
  } catch (err) {
    console.warn("Failed to fork session:", err);
  }
}

// Share the active session (POST /api/session/:id/share); returns the share
// URL on success, null on any failure so the caller never has to catch.
// UNVERIFIED against /doc — see docs/opencode-api.md
export async function shareSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return null;
  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/share`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return (body && body.data && body.data.url) || null;
  } catch (err) {
    console.warn("Failed to share session:", err);
    return null;
  }
}

// Compact/summarize the active session's context (POST /api/session/:id/summarize),
// then reconcile the transcript with server truth.
// UNVERIFIED against /doc — see docs/opencode-api.md
export async function compactSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  try {
    const res = await fetch(`${apiBase()}/session/${sessionID}/summarize`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (res.ok) await refreshActiveMessages();
  } catch (err) {
    console.warn("Failed to compact session:", err);
  }
}

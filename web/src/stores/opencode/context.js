// Token and context accounting — what the usage popover reads and what decides
// when a session needs compacting.
//
// Two sources, and which one you're looking at matters: a local estimate
// (message tokens over the model catalog's context limit) until
// GET /session/{id}/context answers, after which the server's own accounting
// wins permanently for that session. `contextUsage.fromServer` records that,
// so the estimate can never overwrite server truth after the fact.
import { opencodeStore } from "./state.js";
import { getJSON } from "../../lib/api.js";

// Update sessionStats (kept in the exact shape UsagePopover expects) from an
// assistant message.
export function updateSessionStats(info) {
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

// session.usage.updated carries session-wide totals directly, so set them rather
// than re-deriving from per-message tokens.
export function applyUsageUpdate(props) {
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

// The local estimate: used tokens over the model catalog's context limit.
// Yields to the server's own accounting once that has answered.
function setDerivedContextPercent(used, contextLimit) {
  const usage = opencodeStore.sessionStats.contextUsage;
  if (usage.fromServer) return;
  usage.used = used;
  usage.limit = contextLimit || null;
  usage.percent = contextLimit ? (used / contextLimit) * 100 : 0;
}

// Reset to the local-estimate state. Context accounting is per-session, so
// carrying the previous session's server-sourced figure over would show a stale
// number as authoritative.
export function resetContextUsage() {
  opencodeStore.sessionStats.contextUsage = { percent: 0, used: null, limit: null, fromServer: false };
}

// GET /api/session/{id}/context — the context/token accounting the server
// actually applies. The response shape is not pinned down in the spec beyond
// being an object of counts, so read it tolerantly and only take it over the
// local estimate when it yields a usable pair (or an outright percentage).
export async function refreshSessionContext(sessionID) {
  const id = sessionID || opencodeStore.activeSessionId;
  if (!id) return;
  const payload = await getJSON(`/session/${id}/context`);
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

  opencodeStore.sessionStats.contextUsage = { percent, used, limit, fromServer: true };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// A turn emits several session.usage.updated events; coalesce them into one
// context read shortly after the last.
let contextTimer = null;
export function scheduleContextRefresh() {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    contextTimer = null;
    refreshSessionContext();
  }, 750);
}

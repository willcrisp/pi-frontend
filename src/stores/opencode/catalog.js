// The server's catalogs: models, agents, slash commands, skills.
//
// All four are load-once-and-cache lists that populate pickers. They are
// deliberately fault-tolerant — a server build missing one of these routes
// should leave that picker empty, not break the connection.
//
// ⚠️ Fault-tolerant is not the same as recoverable, and conflating the two was a
// real bug: a catalog that never arrived is indistinguishable in the UI from one
// that is legitimately empty. Both render as "no picker", and since these were
// loaded exactly once from initOpenCode() with failures going to console.warn,
// nothing ever asked again — the composer's agent/model selects stayed missing
// until the page was reloaded by hand.
//
// That is not a hypothetical: the frontend and `opencode2 serve` are usually
// started together, so the very first GET /model can easily land while the
// server is still coming up. One unlucky moment at boot, and both selects were
// gone for the rest of the session.
//
// So `loadCatalogs()` retries. Two things trigger a reload:
//
//   · a bounded backoff, while any catalog is still empty — which covers a
//     server that answered before it was ready, and
//   · the event stream (re)connecting (stream.js), which is the strongest
//     evidence available that the server is up now.
//
// Retrying on *empty* rather than only on failure is deliberate: a build that
// answers 200 with `[]` while its provider registry is still loading looks
// exactly like a server with no providers connected, and the cost of being
// wrong is three extra cheap GETs, once.
import { opencodeStore } from "./state.js";
import { apiGet, unwrap } from "../../lib/api.js";
import { applyStoredSelection, lastUsedSelection, resolveVariant, restoreSessionModel } from "./models.js";
import { sendPrompt } from "./prompt.js";

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
// Returns whether the route answered — see the retry policy in the header.
export async function loadModels() {
  try {
    const res = await apiGet("/model");
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
          // carries them.
          variants: normalizeVariants(m.variants),
        }));

      if (!opencodeStore.selectedModel && opencodeStore.availableModels.length > 0) {
        // Prefer the last model the user picked; otherwise the first in the catalog.
        if (!applyStoredSelection(lastUsedSelection())) {
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
      return true;
    }
    console.warn(`Could not load opencode models (${res.status})`);
    return false;
  } catch (err) {
    console.warn("Could not load opencode models:", err);
    return false;
  }
}

// Fetch available agents (GET /api/agent -> { data: Agent.Info[] }); hide subagents/hidden.
export async function loadAgents() {
  try {
    const res = await apiGet("/agent");
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
      return true;
    }
    console.warn(`Could not load opencode agents (${res.status})`);
    return false;
  } catch (err) {
    console.warn("Could not load opencode agents:", err);
    return false;
  }
}

// Fetch available slash commands (GET /api/command -> { data: [...] }).
export async function loadCommands() {
  try {
    const res = await apiGet("/command");
    if (!res.ok) return false;
    opencodeStore.commands = unwrap(await res.json());
    return true;
  } catch (err) {
    console.warn("Could not load opencode commands:", err);
    return false;
  }
}

// Fetch available skills (GET /api/skill -> { data: [...] }); optional —
// older servers without the route just leave the list empty.
export async function loadSkills() {
  try {
    const res = await apiGet("/skill");
    if (!res.ok) return false;
    opencodeStore.skills = unwrap(await res.json());
    return true;
  } catch (err) {
    console.warn("Could not load opencode skills:", err);
    return false;
  }
}

// --- Keeping them loaded -----------------------------------------------------

// Only models and agents gate a control the user needs (the composer's two
// selects). Commands and skills feed the "/" menu, which degrades to "no
// matches" — worth retrying alongside, not worth blocking on.
const CATALOGS = [
  { load: loadModels, isEmpty: () => !opencodeStore.availableModels.length },
  { load: loadAgents, isEmpty: () => !opencodeStore.availableAgents.length },
  { load: loadCommands, isEmpty: () => !opencodeStore.commands.length },
  { load: loadSkills, isEmpty: () => !opencodeStore.skills.length },
];

// Backoff for a server that is still starting: ~1s, 2s, 4s, 8s, then stop. Long
// enough to cover a slow boot, bounded so a server that genuinely has no models
// isn't polled forever.
const RETRY_DELAYS = [1000, 2000, 4000, 8000];
let retryTimer = null;
let retryIndex = 0;

function cancelRetries() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

// Load anything still missing, then schedule the next attempt if it's still
// missing after that. `force` ignores the exhausted backoff — the event stream
// coming up is new information, so it gets a fresh set of attempts.
export async function loadCatalogs({ force = false } = {}) {
  if (force) {
    cancelRetries();
    retryIndex = 0;
  }
  const pending = CATALOGS.filter((c) => c.isEmpty());
  if (!pending.length) {
    cancelRetries();
    opencodeStore.catalogFailed = false;
    return;
  }

  const results = await Promise.all(pending.map((c) => c.load()));
  const stillMissing = CATALOGS.some((c) => c.isEmpty());
  if (!stillMissing) {
    cancelRetries();
    opencodeStore.catalogFailed = false;
    return;
  }

  // Distinguish "asked and was refused" from "asked and got an empty list": only
  // the former justifies telling the user something is wrong.
  if (results.some((ok) => !ok)) opencodeStore.catalogFailed = true;

  if (retryTimer || retryIndex >= RETRY_DELAYS.length) return;
  const delay = RETRY_DELAYS[retryIndex++];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    loadCatalogs();
  }, delay);
}

// Run a slash command. The V2 HttpApi has no server-side command dispatch
// route, so this just sends the raw "/name args" text as a plain prompt —
// the agent parses the leading slash itself.
export async function runCommand(name, args) {
  await sendPrompt(`/${name}${args ? ` ${args}` : ""}`);
}

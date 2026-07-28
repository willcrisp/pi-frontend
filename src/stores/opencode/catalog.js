// The server's catalogs: models, agents, slash commands, skills.
//
// All four are load-once-and-cache lists that populate pickers. They are
// deliberately fault-tolerant — a server build missing one of these routes
// should leave that picker empty, not break the connection.
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
    }
  } catch (err) {
    console.warn("Could not load opencode models:", err);
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
    }
  } catch (err) {
    console.warn("Could not load opencode agents:", err);
  }
}

// Fetch available slash commands (GET /api/command -> { data: [...] }).
export async function loadCommands() {
  try {
    const res = await apiGet("/command");
    if (res.ok) opencodeStore.commands = unwrap(await res.json());
  } catch (err) {
    console.warn("Could not load opencode commands:", err);
  }
}

// Fetch available skills (GET /api/skill -> { data: [...] }); optional —
// older servers without the route just leave the list empty.
export async function loadSkills() {
  try {
    const res = await apiGet("/skill");
    if (res.ok) opencodeStore.skills = unwrap(await res.json());
  } catch (err) {
    console.warn("Could not load opencode skills:", err);
  }
}

// Run a slash command. The V2 HttpApi has no server-side command dispatch
// route, so this just sends the raw "/name args" text as a plain prompt —
// the agent parses the leading slash itself.
export async function runCommand(name, args) {
  await sendPrompt(`/${name}${args ? ` ${args}` : ""}`);
}

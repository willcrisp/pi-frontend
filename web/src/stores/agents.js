// REST client + reactive store for agent-definition management (markdown
// files with YAML frontmatter under ~/.pi/agent/agents "user" scope and
// <project>/.pi/agents "project" scope). Mirrors the conventions in ssh.js.
import { reactive } from "vue";
import { THINKING_LEVELS } from "./pi.js";
import { projectsStore } from "./projects.js";

export const agentsStore = reactive({
  open: false,
  agents: [], // [{ scope, fileName, name, description, tools, model, systemPrompt, raw, parseError }]
  loading: false,
  saving: false,
  error: "",
  editing: null, // null = list view; otherwise a working copy for the editor
});

export function openAgents() {
  agentsStore.open = true;
  agentsStore.editing = null;
  agentsStore.error = "";
  // AgentsDialog fetches on mount (it's v-if-gated on `open`), so no fetch here.
}

export function closeAgents() {
  agentsStore.open = false;
  agentsStore.editing = null;
  agentsStore.error = "";
}

export async function fetchAgents() {
  agentsStore.loading = true;
  agentsStore.error = "";
  try {
    const projectId = projectsStore.currentProjectId;
    const url = projectId ? `/api/agents?projectId=${encodeURIComponent(projectId)}` : "/api/agents";
    const res = await fetch(url);
    if (!res.ok) {
      const message = await res.text().catch(() => "");
      throw new Error(message || `failed to load agents (${res.status})`);
    }
    const data = await res.json();
    agentsStore.agents = data.agents || [];
  } catch (e) {
    agentsStore.error = e.message || String(e);
  } finally {
    agentsStore.loading = false;
  }
}

export async function saveAgent(payload) {
  agentsStore.saving = true;
  agentsStore.error = "";
  try {
    const res = await fetch("/api/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const message = await res.text().catch(() => "");
      throw new Error(message || `failed to save agent (${res.status})`);
    }
    await fetchAgents();
    return true;
  } catch (e) {
    agentsStore.error = e.message || String(e);
    return false;
  } finally {
    agentsStore.saving = false;
  }
}

export async function deleteAgent(agent) {
  agentsStore.saving = true;
  agentsStore.error = "";
  try {
    const params = new URLSearchParams({ scope: agent.scope, fileName: agent.fileName });
    if (agent.scope === "project" && projectsStore.currentProjectId) {
      params.set("projectId", projectsStore.currentProjectId);
    }
    const res = await fetch(`/api/agents?${params.toString()}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const message = await res.text().catch(() => "");
      throw new Error(message || `failed to delete agent (${res.status})`);
    }
    await fetchAgents();
    return true;
  } catch (e) {
    agentsStore.error = e.message || String(e);
    return false;
  } finally {
    agentsStore.saving = false;
  }
}

// pi model strings may carry a trailing thinking-level suffix,
// `provider/id:<level>`. Model ids can legitimately contain ":" themselves
// (e.g. ollama's llama3:8b), so only strip the suffix when it's exactly one
// of THINKING_LEVELS.
export function splitModelThinking(model) {
  if (!model) return { base: "", level: "" };
  const i = model.lastIndexOf(":");
  if (i === -1) return { base: model, level: "" };
  const level = model.slice(i + 1);
  if (THINKING_LEVELS.includes(level)) {
    return { base: model.slice(0, i), level };
  }
  return { base: model, level: "" };
}

export function joinModelThinking(base, level) {
  if (!base) return "";
  return level ? `${base}:${level}` : base;
}

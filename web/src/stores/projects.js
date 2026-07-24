// OpenCode V2 Projects & Sessions Store
import { reactive } from "vue";
import { connectToSession, opencodeStore, selectedModelRef } from "./opencode.js";
import { apiBase, authHeaders } from "./ssh.js";

// Unwrap the opencode2 `{ data: [...] }` list envelope.
function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

const LAST_SESSION_KEY = "opencode-web:lastSessionId";

export const projectsStore = reactive({
  projects: [], // [{ id, name, path }]
  currentProjectId: null,
  sessions: [], // [{ id, title, updatedAt, directory }]
  loadingSessions: false,
});

export async function fetchSessions() {
  projectsStore.loadingSessions = true;
  try {
    const res = await fetch(`${apiBase()}/session`, { headers: authHeaders() });
    if (res.ok) {
      const list = unwrap(await res.json());
      projectsStore.sessions = list
        .map((s) => ({
          id: s.id,
          title: s.title || "Untitled",
          updatedAt: (s.time && (s.time.updated || s.time.created)) || 0,
          // Session.location.directory is the project root (see docs/opencode-api.md) —
          // this endpoint's SessionV2Info nests it under `location`, unlike the legacy
          // (non-V2) Session type, which has a flat top-level `directory`.
          directory: (s.location && s.location.directory) || "",
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
  } catch (err) {
    console.error("Failed to fetch OpenCode sessions:", err);
  } finally {
    projectsStore.loadingSessions = false;
  }
}

// Basename of a session's directory, for a short group-header label (full path stays
// available as the group's `directory` for a tooltip).
function directoryLabel(directory) {
  if (!directory) return "(unknown project)";
  const trimmed = directory.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || trimmed;
}

// Group sessions by their project root directory for the sidebar. `sessions` is assumed
// already sorted most-recent-first (see fetchSessions), so the first session seen per
// directory carries that group's most recent activity and groups come out in recency order
// with no extra sort needed.
export function groupSessionsByDirectory(sessions) {
  const groups = [];
  const byDirectory = new Map();
  for (const s of sessions) {
    let group = byDirectory.get(s.directory);
    if (!group) {
      group = { directory: s.directory, label: directoryLabel(s.directory), sessions: [] };
      byDirectory.set(s.directory, group);
      groups.push(group);
    }
    group.sessions.push(s);
  }
  return groups;
}

export async function startNewChat() {
  try {
    // opencode2 create body takes no title (rename endpoint sets it); seed with current selection.
    const body = {};
    if (opencodeStore.selectedAgent) body.agent = opencodeStore.selectedAgent;
    const modelRef = selectedModelRef();
    if (modelRef) body.model = modelRef;

    const res = await fetch(`${apiBase()}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const payload = await res.json();
      const newId = payload && payload.data ? payload.data.id : payload && payload.id;
      await fetchSessions();
      if (newId) {
        openSession(newId);
      }
    }
  } catch (err) {
    console.error("Failed to create new OpenCode session:", err);
  }
}

export async function removeSession(sessionID) {
  try {
    await fetch(`${apiBase()}/session/${sessionID}`, { method: "DELETE", headers: authHeaders() });
    projectsStore.sessions = projectsStore.sessions.filter((s) => s.id !== sessionID);
    if (opencodeStore.activeSessionId === sessionID) {
      if (projectsStore.sessions.length > 0) {
        openSession(projectsStore.sessions[0].id);
      } else {
        startNewChat();
      }
    }
  } catch (err) {
    console.error("Failed to delete session:", err);
  }
}

export function openSession(sessionID) {
  if (!sessionID) return;
  localStorage.setItem(LAST_SESSION_KEY, sessionID);
  connectToSession(sessionID);
}

export async function initProjects() {
  await fetchSessions();

  const lastId = localStorage.getItem(LAST_SESSION_KEY);
  const found = projectsStore.sessions.find((s) => s.id === lastId);

  if (found) {
    openSession(found.id);
  } else if (projectsStore.sessions.length > 0) {
    openSession(projectsStore.sessions[0].id);
  } else {
    await startNewChat();
  }
}

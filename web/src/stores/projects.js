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
  sessions: [], // [{ id, title, updatedAt }]
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
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
  } catch (err) {
    console.error("Failed to fetch OpenCode sessions:", err);
  } finally {
    projectsStore.loadingSessions = false;
  }
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

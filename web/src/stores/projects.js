// OpenCode V2 Projects & Sessions Store
import { reactive } from "vue";
import { connectToSession, opencodeStore } from "./opencode.js";

const LAST_SESSION_KEY = "opencode-web:lastSessionId";

export const projectsStore = reactive({
  projects: [], // [{ id, name, path }]
  currentProjectId: null,
  sessions: [], // [{ id, title, updatedAt }]
  loadingSessions: false,
});

export async function fetchProjects() {
  try {
    const res = await fetch("/api/project");
    if (!res.ok) return;
    const data = await res.json();
    projectsStore.projects = Array.isArray(data) ? data : [data];
    if (projectsStore.projects.length > 0 && !projectsStore.currentProjectId) {
      projectsStore.currentProjectId = projectsStore.projects[0].id || projectsStore.projects[0].path || "default";
    }
  } catch (err) {
    console.warn("Failed to fetch OpenCode projects:", err);
  }
}

export async function fetchSessions() {
  projectsStore.loadingSessions = true;
  try {
    const res = await fetch("/api/session");
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.sessions || [];
      projectsStore.sessions = list.map((s) => ({
        id: s.id || s.sessionID,
        title: s.title || s.name || `Session ${s.id || s.sessionID}`,
        updatedAt: s.updatedAt || s.createdAt || Date.now(),
      }));
    }
  } catch (err) {
    console.error("Failed to fetch OpenCode sessions:", err);
  } finally {
    projectsStore.loadingSessions = false;
  }
}

export async function startNewChat() {
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Session" }),
    });

    if (res.ok) {
      const newSessionObj = await res.json();
      const newId = newSessionObj.id || newSessionObj.sessionID;
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
    await fetch(`/api/session/${sessionID}`, { method: "DELETE" });
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
  await fetchProjects();
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

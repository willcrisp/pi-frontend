// REST client + reactive store for the project list and each project's chat
// (session) history. Session switching itself goes over the project's own
// WebSocket via pi's `new_session`/`switch_session` RPC commands (pi.js);
// this module only deals with discovering what projects/sessions exist.
import { reactive } from "vue";
import { connectToProject, newSession, resetChat, switchSession } from "./pi.js";

const LAST_PROJECT_KEY = "pi-web:lastProjectId";

export const projectsStore = reactive({
  projects: [], // [{id, name, path}]
  currentProjectId: null,
  sessions: [], // [{path, title, mtimeMs}] for the current project
  loadingSessions: false,
});

export async function fetchProjects() {
  const res = await fetch("/api/projects");
  if (!res.ok) return;
  projectsStore.projects = await res.json();
}

export async function addProject(name, path) {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path }),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(message || `failed to add project (${res.status})`);
  }
  const project = await res.json();
  projectsStore.projects.push(project);
  return project;
}

export async function removeProject(id) {
  const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`failed to remove project (${res.status})`);
  }
  projectsStore.projects = projectsStore.projects.filter((p) => p.id !== id);
  if (projectsStore.currentProjectId === id) {
    projectsStore.currentProjectId = null;
    projectsStore.sessions = [];
    resetChat();
  }
}

export async function fetchSessions(id) {
  if (!id) return;
  projectsStore.loadingSessions = true;
  try {
    const res = await fetch(`/api/projects/${id}/sessions`);
    if (id !== projectsStore.currentProjectId) return; // stale response
    projectsStore.sessions = res.ok ? await res.json() : [];
  } finally {
    if (id === projectsStore.currentProjectId) projectsStore.loadingSessions = false;
  }
}

export function selectProject(id) {
  if (projectsStore.currentProjectId === id) return;
  projectsStore.currentProjectId = id;
  localStorage.setItem(LAST_PROJECT_KEY, id);
  connectToProject(id);
  fetchSessions(id);
}

export function startNewChat() {
  newSession();
}

export function openSession(path) {
  switchSession(path);
}

export function refreshCurrentSessions() {
  fetchSessions(projectsStore.currentProjectId);
}

export async function initProjects() {
  await fetchProjects();
  const last = localStorage.getItem(LAST_PROJECT_KEY);
  const initial = projectsStore.projects.find((p) => p.id === last) || projectsStore.projects[0];
  if (initial) selectProject(initial.id);
}

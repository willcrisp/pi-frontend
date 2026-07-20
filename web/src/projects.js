// REST client + reactive store for the project list and each project's chat
// (session) history. Session switching itself goes over the project's own
// WebSocket via pi's `new_session`/`switch_session` RPC commands (pi.js);
// this module only deals with discovering what projects/sessions exist.
import { reactive } from "vue";
import { connectToProject, newSession, resetChat, switchSession } from "./pi.js";

const LAST_PROJECT_KEY = "pi-web:lastProjectId";
const ARCHIVE_KEY = "pi-web:archivedSessions";

function loadArchived() {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

const archivedPaths = loadArchived();

function saveArchived() {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...archivedPaths]));
}

export const projectsStore = reactive({
  projects: [], // [{id, name, path}]
  currentProjectId: null,
  sessions: [], // [{path, title, mtimeMs}] for the current project
  loadingSessions: false,
  archivedVersion: 0, // bumped on archive/unarchive to trigger reactivity
});

export function isArchived(path) {
  projectsStore.archivedVersion; // reactive dependency
  return archivedPaths.has(path);
}

export function toggleArchive(path) {
  if (archivedPaths.has(path)) archivedPaths.delete(path);
  else archivedPaths.add(path);
  saveArchived();
  projectsStore.archivedVersion++;
}

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
  sessionsCache.delete(id);
  if (projectsStore.currentProjectId === id) {
    projectsStore.currentProjectId = null;
    projectsStore.sessions = [];
    resetChat();
  }
}

// Last fetched chat list per project, so re-selecting a project shows its
// history instantly and the refetch just updates it in place. Pairs with the
// message-level snapshot cache in pi.js.
const sessionsCache = new Map();

export async function fetchSessions(id) {
  if (!id) return;
  const cached = sessionsCache.get(id);
  projectsStore.sessions = cached || [];
  // Only show the spinner when there's genuinely nothing to look at.
  projectsStore.loadingSessions = !cached;
  try {
    const res = await fetch(`/api/projects/${id}/sessions`);
    const sessions = res.ok ? await res.json() : [];
    sessionsCache.set(id, sessions);
    if (id !== projectsStore.currentProjectId) return; // stale response
    projectsStore.sessions = sessions;
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

// OpenCode V2 Projects & Sessions Store
import { reactive } from "vue";
import { connectToSession, opencodeStore, selectedModelRef } from "./opencode.js";
import { apiBase, authHeaders } from "./ssh.js";
import { fetchBranches } from "./git.js";

// Unwrap the opencode2 `{ data: [...] }` list envelope.
function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

const LAST_SESSION_KEY = "opencode-web:lastSessionId";
const ARCHIVED_KEY = "opencode-web:archivedProjects"; // string[] of directories

function loadArchived() {
  try {
    const list = JSON.parse(localStorage.getItem(ARCHIVED_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export const projectsStore = reactive({
  sessions: [], // [{ id, title, updatedAt, directory }]
  loadingSessions: false,
  // Client-only project archiving (by root directory) — the server has no
  // project entity to archive, so this just hides groups in the sidebar.
  archivedDirectories: loadArchived(),
});

export function isArchived(directory) {
  return projectsStore.archivedDirectories.includes(directory);
}

export function setProjectArchived(directory, archived) {
  const list = projectsStore.archivedDirectories.filter((d) => d !== directory);
  if (archived) list.push(directory);
  projectsStore.archivedDirectories = list;
  try {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(list));
  } catch {}
}

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

// Create a session, optionally rooted at `directory`. Body shape is
// `{ agent?, model?, location?: Location.Ref }` where Location.Ref is
// `{ directory, workspaceID? }` — verified against /openapi.json.
export async function startNewChat(directory) {
  try {
    const body = {};
    if (opencodeStore.selectedAgent) body.agent = opencodeStore.selectedAgent;
    const modelRef = selectedModelRef();
    if (modelRef) body.model = modelRef;
    if (directory) body.location = { directory };

    const res = await fetch(`${apiBase()}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`session create failed (${res.status})`);
    }
    const payload = await res.json();
    const newId = payload && payload.data ? payload.data.id : payload && payload.id;
    await fetchSessions();
    if (newId) {
      openSession(newId);
    }
  } catch (err) {
    console.error("Failed to create new OpenCode session:", err);
    throw err;
  }
}

// The V2 HttpApi in this build does not expose DELETE /session/{id}, so this
// is a client-only hide — the session will reappear the next time fetchSessions
// runs. If a real delete route lands, add the fetch back.
export async function removeSession(sessionID) {
  projectsStore.sessions = projectsStore.sessions.filter((s) => s.id !== sessionID);
  if (opencodeStore.activeSessionId === sessionID) {
    if (projectsStore.sessions.length > 0) {
      openSession(projectsStore.sessions[0].id);
    } else {
      startNewChat().catch(() => {});
    }
  }
}

export function openSession(sessionID) {
  if (!sessionID) return;
  localStorage.setItem(LAST_SESSION_KEY, sessionID);
  connectToSession(sessionID);
  const session = projectsStore.sessions.find((s) => s.id === sessionID);
  if (session?.directory) fetchBranches(session.directory);
}

export function activeSessionDirectory() {
  const id = opencodeStore.activeSessionId;
  if (!id) return "";
  const session = projectsStore.sessions.find((s) => s.id === id);
  return session?.directory || "";
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
    await startNewChat().catch(() => {});
  }
}

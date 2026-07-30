// OpenCode V2 Projects & Sessions Store
import { reactive } from "vue";
import { connectToSession, opencodeStore, selectedModelRef } from "./opencode.js";
import { fetchBranches } from "./git.js";
import { apiGet, apiPost, unwrap } from "../lib/api.js";
import { readArray, writeJSON, readString, writeString } from "../lib/storage.js";

const LAST_SESSION_KEY = "opencode-web:lastSessionId";
const ARCHIVED_KEY = "opencode-web:archivedProjects"; // string[] of directories

export const projectsStore = reactive({
  sessions: [], // [{ id, title, updatedAt, directory, parentID }]
  loadingSessions: false,
  // Client-only project archiving (by root directory) — the server has no
  // project entity to archive, so this just hides groups in the sidebar.
  archivedDirectories: readArray(ARCHIVED_KEY),
  // child sessionID -> parent sessionID, recorded when the user drills into a
  // sub-agent from its card. The server reports the same link as `parentID`,
  // but only once the session list has caught up with a child it may have
  // created seconds ago; this makes the breadcrumb correct immediately.
  subagentParents: {},
});

export function isArchived(directory) {
  return projectsStore.archivedDirectories.includes(directory);
}

export function setProjectArchived(directory, archived) {
  const list = projectsStore.archivedDirectories.filter((d) => d !== directory);
  if (archived) list.push(directory);
  projectsStore.archivedDirectories = list;
  writeJSON(ARCHIVED_KEY, list);
}

export async function fetchSessions() {
  projectsStore.loadingSessions = true;
  try {
    const res = await apiGet("/session");
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
          // Set only on a dispatched sub-agent's session. Drives both the
          // sidebar filter and the breadcrumb — see rootSessions/sessionAncestry.
          parentID: s.parentID || "",
          // SessionV2.Info meters every session, so the whole history's usage is
          // already in this one response — stores/usage.js aggregates it without
          // a second call. `cost` is the server's own figure and reads 0 for a
          // provider configured without pricing (see stores/usage.js).
          cost: typeof s.cost === "number" ? s.cost : 0,
          tokens: s.tokens || null,
          model: s.model || null,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
  } catch (err) {
    console.error("Failed to fetch OpenCode sessions:", err);
  } finally {
    projectsStore.loadingSessions = false;
  }
}

// Sessions the user actually started. A session with a `parentID` is a
// dispatched sub-agent: it belongs to its parent's transcript (as an expandable
// card) and to the breadcrumb, never to the sidebar, where it would read as a
// chat of its own and bury the real ones.
export function rootSessions() {
  return projectsStore.sessions.filter((s) => !s.parentID);
}

// The server's `parentID` is authoritative; the locally recorded link covers a
// child too new to be in the session list yet.
export function parentSessionId(sessionID) {
  if (!sessionID) return "";
  const session = projectsStore.sessions.find((s) => s.id === sessionID);
  return session?.parentID || projectsStore.subagentParents[sessionID] || "";
}

export function isSubagentSession(sessionID) {
  return !!parentSessionId(sessionID);
}

// Ancestor chain for the breadcrumb, outermost session first. Walks the parent
// links so a sub-agent that itself dispatched one shows the whole path back.
// `seen` guards against a cycle — a malformed link must not spin forever.
export function sessionAncestry(sessionID) {
  const chain = [];
  const seen = new Set([sessionID]);
  let id = parentSessionId(sessionID);
  while (id && !seen.has(id)) {
    seen.add(id);
    const session = projectsStore.sessions.find((s) => s.id === id);
    chain.unshift({ id, title: session?.title || "parent session" });
    id = parentSessionId(id);
  }
  return chain;
}

// Basename of a session's directory, for a short group-header label (full path stays
// available as the group's `directory` for a tooltip).
export function directoryLabel(directory) {
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

    const res = await apiPost("/session", body);

    if (!res.ok) {
      throw new Error(`session create failed (${res.status})`);
    }
    const payload = await res.json();
    const newId = payload && payload.data ? payload.data.id : payload && payload.id;
    await fetchSessions();
    if (newId) {
      // Awaited so a caller that wants to act on the new chat (forking sends it
      // a prompt) does so after its transcript load has landed, not before —
      // the load would overwrite anything appended in between.
      await openSession(newId);
    }
    return newId;
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
    // Fall back to a real chat, never to a sub-agent's session — landing in one
    // with no way back would be a dead end.
    const roots = rootSessions();
    if (roots.length > 0) {
      openSession(roots[0].id);
    } else {
      startNewChat().catch(() => {});
    }
  }
}

// Returns the connect promise — awaiting it is optional (most callers just
// navigate), but it's how a caller waits for the transcript to be loaded.
export function openSession(sessionID) {
  if (!sessionID) return Promise.resolve();
  writeString(LAST_SESSION_KEY, sessionID);
  const opened = connectToSession(sessionID);
  const session = projectsStore.sessions.find((s) => s.id === sessionID);
  if (session?.directory) fetchBranches(session.directory);
  return opened;
}

// Drill into a dispatched sub-agent's own session from its card in the parent
// transcript. Navigation is immediate and the parent link is recorded up front
// so the breadcrumb is right on arrival; the list refresh that follows fills in
// the child's title and directory, which only the server knows.
export function openSubagentSession(childID, parentID) {
  if (!childID) return;
  if (parentID) projectsStore.subagentParents[childID] = parentID;
  openSession(childID);
  fetchSessions().catch(() => {});
}

export function activeSessionDirectory() {
  const id = opencodeStore.activeSessionId;
  if (!id) return "";
  const session = projectsStore.sessions.find((s) => s.id === id);
  return session?.directory || "";
}

export async function initProjects() {
  await fetchSessions();

  const lastId = readString(LAST_SESSION_KEY);
  // A sub-agent session is a legitimate thing to have been looking at, so it is
  // still restorable by id — the breadcrumb gets you back out. Only the blind
  // "just open something" fallback is restricted to real chats.
  const found = projectsStore.sessions.find((s) => s.id === lastId);
  const roots = rootSessions();

  if (found) {
    openSession(found.id);
  } else if (roots.length > 0) {
    openSession(roots[0].id);
  } else {
    await startNewChat().catch(() => {});
  }
}

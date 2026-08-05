<!--
  Sidebar component: list sessions grouped by project root directory (each
  session's own working directory, per opencode's Session.Info), add a new
  project (creates a session rooted at a chosen directory, with fuzzy
  directory autocomplete backed by the PTY `find` runner in filesearch.js),
  start a new session inside an existing project group, archive projects
  (client-only, projects.js), show the 5 most recent chats per group with a
  "show more" expander, switch active session. Group headers are collapsible,
  most recently active project first.
-->
<script setup>
import { computed, reactive, ref, watch } from "vue";
import { opencodeStore, sessionStatus } from "../../stores/opencode.js";
import { fuzzyScore } from "../../lib/fuzzy.js";
import { readArray, writeJSON } from "../../lib/storage.js";
import {
  openSession,
  projectsStore,
  startNewChat,
  removeSession,
  fetchSessions,
  groupSessionsByDirectory,
  isArchived,
  setProjectArchived,
  rootSessions,
} from "../../stores/projects.js";
import { listDirectories } from "../../stores/filesearch.js";
import { confirmDialog } from "../../stores/confirm.js";
import { closeSidebar, closeSidebarIfDrawer, layoutStore } from "../../stores/layout.js";
import ProvidersDialog from "../dialogs/ProvidersDialog.vue";
import SubagentsDialog from "../dialogs/SubagentsDialog.vue";
import SavedPermissionsDialog from "../dialogs/SavedPermissionsDialog.vue";
import McpDialog from "../dialogs/McpDialog.vue";

const activeSessionId = computed(() => opencodeStore.activeSessionId);

const showArchived = ref(false);
const showProviders = ref(false);
const showSubagents = ref(false);
const showSavedPermissions = ref(false);
const showMcp = ref(false);

// Sub-agent sessions are deliberately absent here: they live as expandable
// cards inside their parent's transcript, and you drill into them from there.
// See rootSessions in stores/projects.js.
const groups = computed(() =>
  groupSessionsByDirectory(rootSessions()).filter(
    (g) => isArchived(g.directory) === showArchived.value
  )
);

const archivedCount = computed(
  () => groupSessionsByDirectory(rootSessions()).filter((g) => isArchived(g.directory)).length
);

// How the sidebar is folded is UI-only state, but it's state the user arranged
// by hand — losing it on every reload meant re-tidying the sidebar each time.
// Both sets are keyed by directory and persisted as plain string arrays.
const COLLAPSED_KEY = "opencode-web:collapsedProjects";
const EXPANDED_KEY = "opencode-web:expandedProjects";

// A group starts expanded until its directory is added here.
const collapsed = reactive(new Set(readArray(COLLAPSED_KEY)));

function toggleGroup(directory) {
  if (collapsed.has(directory)) collapsed.delete(directory);
  else collapsed.add(directory);
}

// Groups show their RECENT_LIMIT most recent chats until expanded here.
const RECENT_LIMIT = 5;
const expanded = reactive(new Set(readArray(EXPANDED_KEY)));

// `reactive(new Set())` tracks mutations, so watching the set itself is enough —
// no need to route every add/delete through a setter.
watch(collapsed, (set) => writeJSON(COLLAPSED_KEY, [...set]));
watch(expanded, (set) => writeJSON(EXPANDED_KEY, [...set]));

function visibleSessions(group) {
  return expanded.has(group.directory) ? group.sessions : group.sessions.slice(0, RECENT_LIMIT);
}

const STATUS_TITLE = {
  working: "Agent working",
  unread: "Agent finished — unread",
};

// The status dot a project header carries: only ever summarizes sessions whose
// own dot is currently hidden (group collapsed, or trimmed by RECENT_LIMIT),
// so it adds information rather than repeating the row below it. Working wins
// over unread — a live run is the more urgent thing to see.
function groupStatus(group) {
  const hidden = collapsed.has(group.directory)
    ? group.sessions
    : group.sessions.filter((s) => !visibleSessions(group).includes(s));
  let unread = false;
  for (const s of hidden) {
    const status = sessionStatus(s.id);
    if (status === "working") return "working";
    if (status === "unread") unread = true;
  }
  return unread ? "unread" : "";
}

// The server exposes no DELETE for sessions, so this only hides the row
// locally — it comes back on refresh. Say so rather than letting the × imply
// a delete that never happened.
async function onRemoveSession(id) {
  const ok = await confirmDialog({
    title: "Hide session",
    message:
      "This server has no delete-session route, so the session is only hidden here — it reappears after a refresh.",
    confirmLabel: "Hide",
    danger: true,
  });
  if (ok) removeSession(id);
}

// "New project" = a session rooted at a user-chosen directory; the group
// appears from the session list itself (no separate project entity).
const showAddForm = ref(false);
const newPath = ref("");
const addError = ref("");
const adding = ref(false);

// Fuzzy directory autocomplete: split the typed path into parent + partial,
// list the parent's subdirectories on the server, subsequence-match the
// partial against each basename (lib/fuzzy.js — the same scorer the palette
// and the composer's menus use).
const pathSuggestions = ref([]);
const showSuggestions = ref(false);
const activeSuggestion = ref(0);
let browseSeq = 0;

async function onPathInput() {
  const raw = newPath.value.trim().replace(/\\/g, "/");
  const seq = ++browseSeq;
  const slash = raw.lastIndexOf("/");
  if (slash < 0) {
    pathSuggestions.value = [];
    showSuggestions.value = false;
    return;
  }
  const parent = slash === 0 ? "/" : raw.slice(0, slash);
  const partial = raw.slice(slash + 1).toLowerCase();

  const dirs = await listDirectories(parent);
  if (seq !== browseSeq) return; // a newer keystroke superseded this lookup

  const scored = [];
  for (const d of dirs) {
    const base = d.slice(d.lastIndexOf("/") + 1).toLowerCase();
    if (!partial) {
      scored.push({ d, score: 0 });
      continue;
    }
    const score = fuzzyScore(partial, base);
    if (score !== null) scored.push({ d, score });
  }
  pathSuggestions.value = scored
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d)
    .slice(0, 12);
  activeSuggestion.value = 0;
  showSuggestions.value = pathSuggestions.value.length > 0;
}

function pickSuggestion(dir) {
  newPath.value = `${dir}/`;
  onPathInput();
}

function onPathKeydown(e) {
  if (!showSuggestions.value || !pathSuggestions.value.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestion.value = (activeSuggestion.value + 1) % pathSuggestions.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestion.value =
      (activeSuggestion.value - 1 + pathSuggestions.value.length) % pathSuggestions.value.length;
  } else if (e.key === "Tab") {
    e.preventDefault();
    pickSuggestion(pathSuggestions.value[activeSuggestion.value]);
  } else if (e.key === "Enter" && showSuggestions.value) {
    // Enter picks the highlighted suggestion when the menu is open; a second
    // Enter (menu closed after exact pick) submits the form.
    const picked = pathSuggestions.value[activeSuggestion.value];
    if (picked && picked !== newPath.value.replace(/\/$/, "")) {
      e.preventDefault();
      pickSuggestion(picked);
    }
  } else if (e.key === "Escape") {
    showSuggestions.value = false;
  }
}

async function submitAdd() {
  const path = newPath.value.trim().replace(/\/+$/, "");
  if (!path || adding.value) return;
  adding.value = true;
  addError.value = "";
  try {
    await startNewChat(path);
    newPath.value = "";
    showAddForm.value = false;
    showSuggestions.value = false;
  } catch (e) {
    addError.value = (e && e.message) || "failed to create project session";
  } finally {
    adding.value = false;
  }
}

// Below stores/layout.js's breakpoint the sidebar is an overlay drawer, so
// picking a session is also the gesture that dismisses it. Docked, this is a
// no-op and openSession behaves exactly as it always did.
function onOpenSession(id) {
  openSession(id);
  closeSidebarIfDrawer();
}

async function newSessionIn(directory) {
  try {
    await startNewChat(directory);
  } catch {
    // surfaced in console; keep the sidebar quiet for per-group creates
  }
}
</script>

<template>
  <!-- Backdrop only exists as a drawer (styles/responsive.css hides it when
       docked); it is a button so it is reachable without a mouse. -->
  <button
    v-if="layoutStore.sidebarOpen"
    type="button"
    class="sidebar-backdrop"
    aria-label="Close the session list"
    @click="closeSidebar"
  ></button>

  <aside class="sidebar" :class="{ open: layoutStore.sidebarOpen }">
    <div class="sidebar-header">
      <span class="sidebar-title">OpenCode Sessions</span>
      <div class="sidebar-header-actions">
        <button
          v-if="archivedCount || showArchived"
          class="icon-btn archive-toggle"
          :class="{ active: showArchived }"
          :title="showArchived ? 'Show active projects' : `Show archived projects (${archivedCount})`"
          @click="showArchived = !showArchived"
        >
          🗄
        </button>
        <button class="icon-btn" title="Refresh sessions" @click="fetchSessions">⟳</button>
        <button class="icon-btn" title="Sub-agents" @click="showSubagents = true">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1.5v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            <rect
              x="2.6"
              y="3.5"
              width="10.8"
              height="9"
              rx="2.4"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M5.8 7.2v1.4M10.2 7.2v1.4"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          class="icon-btn"
          title="Saved permissions"
          @click="showSavedPermissions = true"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="3.3"
              y="7"
              width="9.4"
              height="6.8"
              rx="1.6"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M5.6 7V4.9a2.4 2.4 0 0 1 4.8 0V7"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button class="icon-btn" title="Providers" @click="showProviders = true">⚙</button>
        <button class="icon-btn" title="MCP servers" @click="showMcp = true">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="3.5" r="2" stroke="currentColor" stroke-width="1.2" />
            <circle cx="3.5" cy="12" r="2" stroke="currentColor" stroke-width="1.2" />
            <circle cx="12.5" cy="12" r="2" stroke="currentColor" stroke-width="1.2" />
            <path d="M8 5.5v3M8 8.5L4 10M8 8.5l4 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
        <button class="icon-btn" title="New project" @click="showAddForm = !showAddForm">+</button>
      </div>
    </div>

    <ProvidersDialog v-if="showProviders" @close="showProviders = false" />
    <SubagentsDialog v-if="showSubagents" @close="showSubagents = false" />
    <SavedPermissionsDialog
      v-if="showSavedPermissions"
      @close="showSavedPermissions = false"
    />
    <McpDialog v-if="showMcp" @close="showMcp = false" />

    <form v-if="showAddForm" class="add-project-form" @submit.prevent="submitAdd">
      <div class="path-input-wrap">
        <input
          v-model="newPath"
          placeholder="/path/to/project"
          autocomplete="off"
          autofocus
          @input="onPathInput"
          @focus="onPathInput"
          @keydown="onPathKeydown"
          @blur="showSuggestions = false"
        />
        <ul v-if="showSuggestions && pathSuggestions.length" class="path-suggestions">
          <li
            v-for="(d, i) in pathSuggestions"
            :key="d"
            :class="{ active: i === activeSuggestion }"
            @mousedown.prevent="pickSuggestion(d)"
          >
            {{ d }}
          </li>
        </ul>
      </div>
      <div v-if="addError" class="add-project-error">{{ addError }}</div>
      <button type="submit" :disabled="adding || !newPath.trim()">
        {{ adding ? "creating…" : "create project session" }}
      </button>
    </form>

    <div class="project-list">
      <div v-if="projectsStore.loadingSessions" class="chat-row dim">loading sessions…</div>
      <template v-else>
        <div v-for="group in groups" :key="group.directory" class="project-group">
          <div
            class="project-row"
            :class="{ active: group.sessions.some((s) => s.id === activeSessionId) }"
            :title="group.directory"
            @click="toggleGroup(group.directory)"
          >
            <span class="project-collapse-icon">{{ collapsed.has(group.directory) ? "▸" : "▾" }}</span>
            <span class="project-name">{{ group.label }}</span>
            <span
              v-if="groupStatus(group)"
              class="status-dot"
              :class="groupStatus(group)"
              :title="STATUS_TITLE[groupStatus(group)]"
            ></span>
            <button
              v-if="group.directory"
              class="icon-btn new-chat-btn"
              title="New session in this project"
              @click.stop="newSessionIn(group.directory)"
            >
              +
            </button>
            <button
              v-if="group.directory"
              class="icon-btn archive-btn"
              :title="showArchived ? 'Unarchive project' : 'Archive project'"
              @click.stop="setProjectArchived(group.directory, !showArchived)"
            >
              {{ showArchived ? "↩" : "🗄" }}
            </button>
          </div>
          <div v-if="!collapsed.has(group.directory)" class="chat-history">
            <div
              v-for="s in visibleSessions(group)"
              :key="s.id"
              class="chat-row"
              :class="{ active: s.id === activeSessionId }"
              :title="s.title"
              @click="onOpenSession(s.id)"
            >
              <span
                v-if="sessionStatus(s.id)"
                class="status-dot"
                :class="sessionStatus(s.id)"
                :title="STATUS_TITLE[sessionStatus(s.id)]"
              ></span>
              <span class="chat-title">{{ s.title }}</span>
              <button
                class="icon-btn remove-btn"
                title="Hide session"
                @click.stop="onRemoveSession(s.id)"
              >
                ×
              </button>
            </div>
            <button
              v-if="!expanded.has(group.directory) && group.sessions.length > RECENT_LIMIT"
              class="chat-row show-more"
              @click="expanded.add(group.directory)"
            >
              show {{ group.sessions.length - RECENT_LIMIT }} more…
            </button>
            <button
              v-else-if="expanded.has(group.directory) && group.sessions.length > RECENT_LIMIT"
              class="chat-row show-more"
              @click="expanded.delete(group.directory)"
            >
              show less
            </button>
          </div>
        </div>
        <!-- "Couldn't fetch the list" must not look like "you have no sessions":
             the sidebar is the only route to a session, so the empty version of
             this reads as data loss. -->
        <div v-if="projectsStore.sessionsError" class="chat-row sidebar-error">
          <span>{{ projectsStore.sessionsError }}</span>
          <button type="button" @click="fetchSessions">Retry</button>
        </div>
        <div v-else-if="!groups.length" class="chat-row dim">
          {{ showArchived ? "no archived projects" : "no sessions — click + to create a project" }}
        </div>
      </template>
    </div>
  </aside>
</template>

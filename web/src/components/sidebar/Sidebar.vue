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
import { computed, reactive, ref } from "vue";
import { opencodeStore } from "../../stores/opencode.js";
import {
  openSession,
  projectsStore,
  startNewChat,
  removeSession,
  fetchSessions,
  groupSessionsByDirectory,
  isArchived,
  setProjectArchived,
} from "../../stores/projects.js";
import { listDirectories } from "../../stores/filesearch.js";

const activeSessionId = computed(() => opencodeStore.activeSessionId);

const showArchived = ref(false);

const groups = computed(() =>
  groupSessionsByDirectory(projectsStore.sessions).filter(
    (g) => isArchived(g.directory) === showArchived.value
  )
);

const archivedCount = computed(
  () => groupSessionsByDirectory(projectsStore.sessions).filter((g) => isArchived(g.directory)).length
);

// Collapsed-by-directory state, UI-only (not persisted); a group starts expanded
// until its directory is added here.
const collapsed = reactive(new Set());

function toggleGroup(directory) {
  if (collapsed.has(directory)) collapsed.delete(directory);
  else collapsed.add(directory);
}

// Groups show their RECENT_LIMIT most recent chats until expanded here.
const RECENT_LIMIT = 5;
const expanded = reactive(new Set());

function visibleSessions(group) {
  return expanded.has(group.directory) ? group.sessions : group.sessions.slice(0, RECENT_LIMIT);
}

function onRemoveSession(id) {
  removeSession(id);
}

// "New project" = a session rooted at a user-chosen directory; the group
// appears from the session list itself (no separate project entity).
const showAddForm = ref(false);
const newPath = ref("");
const addError = ref("");
const adding = ref(false);

// Fuzzy directory autocomplete: split the typed path into parent + partial,
// list the parent's subdirectories on the server, subsequence-match the
// partial against each basename.
const pathSuggestions = ref([]);
const showSuggestions = ref(false);
const activeSuggestion = ref(0);
let browseSeq = 0;

function fuzzyScore(q, s) {
  let score = 0;
  let si = 0;
  let prevHit = -2;
  for (const ch of q) {
    const hit = s.indexOf(ch, si);
    if (hit === -1) return null;
    score += 1;
    if (hit === prevHit + 1) score += 2;
    if (hit === 0 || " /\\-_.:".includes(s[hit - 1])) score += 3;
    prevHit = hit;
    si = hit + 1;
  }
  return score - s.length / 100;
}

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

async function newSessionIn(directory) {
  try {
    await startNewChat(directory);
  } catch {
    // surfaced in console; keep the sidebar quiet for per-group creates
  }
}
</script>

<template>
  <aside class="sidebar">
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
        <button class="icon-btn" title="New project" @click="showAddForm = !showAddForm">+</button>
      </div>
    </div>

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
              @click="openSession(s.id)"
            >
              <span
                v-if="s.id === activeSessionId && opencodeStore.isStreaming"
                class="status-dot working"
                title="Agent working"
              ></span>
              <span class="chat-title">{{ s.title }}</span>
              <button
                class="icon-btn remove-btn"
                title="Delete session"
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
        <div v-if="!groups.length" class="chat-row dim">
          {{ showArchived ? "no archived projects" : "no sessions — click + to create a project" }}
        </div>
      </template>
    </div>
  </aside>
</template>

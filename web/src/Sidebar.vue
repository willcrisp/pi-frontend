<script setup>
import { computed, ref, watch } from "vue";
import { store } from "./pi.js";
import { addProject, openSession, projectsStore, removeProject, selectProject, startNewChat } from "./projects.js";

const showAddForm = ref(false);
const newName = ref("");
const newPath = ref("");
const addError = ref("");
const adding = ref(false);

const pathSuggestions = ref([]);
const showSuggestions = ref(false);
const activeSuggestion = ref(-1);
let browseSeq = 0;

async function onPathInput() {
  showSuggestions.value = true;
  activeSuggestion.value = -1;
  const seq = ++browseSeq;
  try {
    const res = await fetch(`/api/browse-dirs?path=${encodeURIComponent(newPath.value)}`);
    const dirs = res.ok ? await res.json() : [];
    if (seq !== browseSeq) return; // stale response
    pathSuggestions.value = dirs;
  } catch {
    if (seq === browseSeq) pathSuggestions.value = [];
  }
}

function pickSuggestion(dir) {
  newPath.value = dir + "/";
  pathSuggestions.value = [];
  showSuggestions.value = false;
  onPathInput();
}

function onPathKeydown(e) {
  if (!showSuggestions.value || !pathSuggestions.value.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestion.value = (activeSuggestion.value + 1) % pathSuggestions.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestion.value = (activeSuggestion.value - 1 + pathSuggestions.value.length) % pathSuggestions.value.length;
  } else if (e.key === "Tab" || e.key === "Enter") {
    if (activeSuggestion.value >= 0) {
      e.preventDefault();
      pickSuggestion(pathSuggestions.value[activeSuggestion.value]);
    }
  } else if (e.key === "Escape") {
    showSuggestions.value = false;
  }
}

const PAGE_SIZE = 5;
const historyLimit = ref(PAGE_SIZE);
watch(
  () => projectsStore.currentProjectId,
  () => {
    historyLimit.value = PAGE_SIZE;
  }
);

const visibleSessions = computed(() => projectsStore.sessions.slice(0, historyLimit.value));
const hasMoreSessions = computed(() => projectsStore.sessions.length > historyLimit.value);

function loadMoreSessions() {
  historyLimit.value += PAGE_SIZE;
}

const activeSessionPath = computed(() => store.sessionStats?.sessionFile || null);

async function submitAdd() {
  const name = newName.value.trim();
  const path = newPath.value.trim();
  if (!name || !path) return;
  adding.value = true;
  addError.value = "";
  try {
    const project = await addProject(name, path);
    newName.value = "";
    newPath.value = "";
    showAddForm.value = false;
    selectProject(project.id);
  } catch (e) {
    addError.value = e.message || "failed to add project";
  } finally {
    adding.value = false;
  }
}

async function onRemove(id, name) {
  if (!confirm(`Remove project "${name}"? Its running chat will be stopped.`)) return;
  try {
    await removeProject(id);
  } catch (e) {
    alert(e.message || "failed to remove project");
  }
}

function relativeTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">projects</span>
      <button class="icon-btn" title="Add project" @click="showAddForm = !showAddForm">+</button>
    </div>

    <form v-if="showAddForm" class="add-project-form" @submit.prevent="submitAdd">
      <input v-model="newName" placeholder="name" autofocus />
      <div class="path-input-wrap">
        <input
          v-model="newPath"
          placeholder="/path/to/project"
          autocomplete="off"
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
      <button type="submit" :disabled="adding">{{ adding ? "adding…" : "add project" }}</button>
    </form>

    <div class="project-list">
      <div v-for="p in projectsStore.projects" :key="p.id" class="project-group">
        <div
          class="project-row"
          :class="{ active: p.id === projectsStore.currentProjectId }"
          @click="selectProject(p.id)"
        >
          <span class="project-name" :title="p.path">{{ p.name }}</span>
          <button class="icon-btn remove-btn" title="Remove project" @click.stop="onRemove(p.id, p.name)">×</button>
        </div>

        <div v-if="p.id === projectsStore.currentProjectId" class="chat-history">
          <div class="chat-row new-chat" @click="startNewChat">+ new chat</div>
          <div v-if="projectsStore.loadingSessions" class="chat-row dim">loading…</div>
          <template v-else>
            <div
              v-for="s in visibleSessions"
              :key="s.path"
              class="chat-row"
              :class="{ active: s.path === activeSessionPath }"
              :title="s.title"
              @click="openSession(s.path)"
            >
              <span class="chat-title">{{ s.title }}</span>
              <span class="chat-time">{{ relativeTime(s.mtimeMs) }}</span>
            </div>
            <div v-if="hasMoreSessions" class="chat-row load-more" @click="loadMoreSessions">load more…</div>
            <div v-if="!projectsStore.sessions.length" class="chat-row dim">no past chats</div>
          </template>
        </div>
      </div>

      <div v-if="!projectsStore.projects.length" class="sidebar-empty">no projects yet — add one above</div>
    </div>
  </aside>
</template>

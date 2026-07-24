<!--
  Sidebar component: list sessions grouped by project root directory (each
  session's own working directory, per opencode's Session.Info), start new
  session, switch active session. Group headers are collapsible, most
  recently active project first.
-->
<script setup>
import { computed, reactive } from "vue";
import { opencodeStore } from "../../stores/opencode.js";
import {
  openSession,
  projectsStore,
  startNewChat,
  removeSession,
  fetchSessions,
  groupSessionsByDirectory,
} from "../../stores/projects.js";

const activeSessionId = computed(() => opencodeStore.activeSessionId);

const groups = computed(() => groupSessionsByDirectory(projectsStore.sessions));

// Collapsed-by-directory state, UI-only (not persisted); a group starts expanded
// until its directory is added here.
const collapsed = reactive(new Set());

function toggleGroup(directory) {
  if (collapsed.has(directory)) collapsed.delete(directory);
  else collapsed.add(directory);
}

function onRemoveSession(id) {
  removeSession(id);
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">OpenCode Sessions</span>
      <div class="sidebar-header-actions">
        <button class="icon-btn" title="Refresh sessions" @click="fetchSessions">⟳</button>
        <button class="icon-btn" title="New Session" @click="startNewChat">+</button>
      </div>
    </div>

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
          </div>
          <div v-if="!collapsed.has(group.directory)" class="chat-history">
            <div
              v-for="s in group.sessions"
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
          </div>
        </div>
        <div v-if="!projectsStore.sessions.length" class="chat-row dim">
          no active sessions — click + to create one
        </div>
      </template>
    </div>
  </aside>
</template>

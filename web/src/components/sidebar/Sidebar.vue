<!--
  Sidebar component: list sessions, start new session, switch active session.
-->
<script setup>
import { computed } from "vue";
import { opencodeStore } from "../../stores/opencode.js";
import {
  openSession,
  projectsStore,
  startNewChat,
  removeSession,
  fetchSessions,
} from "../../stores/projects.js";

const activeSessionId = computed(() => opencodeStore.activeSessionId);

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
      <div class="chat-history">
        <div v-if="projectsStore.loadingSessions" class="chat-row dim">loading sessions…</div>
        <template v-else>
          <div
            v-for="s in projectsStore.sessions"
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
          <div v-if="!projectsStore.sessions.length" class="chat-row dim">
            no active sessions — click + to create one
          </div>
        </template>
      </div>
    </div>
  </aside>
</template>

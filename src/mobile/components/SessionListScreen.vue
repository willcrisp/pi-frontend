<script setup>
// The session list. Flat and recency-ordered — the desktop groups by project
// directory, which earns its keep across a dozen projects on a wide screen and
// costs a tap per group on a phone.
import { computed, ref } from "vue";
import {
  fetchSessions,
  openSession,
  projectsStore,
  rootSessions,
  startNewChat,
  directoryLabel,
} from "../../stores/projects.js";
import { sessionStatus } from "../../stores/opencode.js";

const emit = defineEmits(["open", "settings"]);
const creating = ref(false);

// rootSessions() drops dispatched sub-agents: they belong to their parent's
// transcript, and in a flat list they'd read as chats of their own and bury the
// real ones.
const sessions = computed(() => rootSessions());

function when(ms) {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function open(id) {
  openSession(id);
  emit("open");
}

async function newChat() {
  creating.value = true;
  try {
    await startNewChat();
    emit("open");
  } catch {
    /* startNewChat logs; the list stays up so there is somewhere to be */
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="screen">
    <header>
      <h1>Chats</h1>
      <div class="actions">
        <button aria-label="Refresh" @click="fetchSessions()">⟳</button>
        <button aria-label="Connection" @click="emit('settings')">⚙</button>
      </div>
    </header>

    <p v-if="projectsStore.sessionsError" class="error">{{ projectsStore.sessionsError }}</p>

    <ul class="list">
      <li v-for="s in sessions" :key="s.id">
        <button class="row" @click="open(s.id)">
          <span class="dot" :class="sessionStatus(s.id)" />
          <span class="body">
            <span class="title">{{ s.title }}</span>
            <span class="meta">{{ directoryLabel(s.directory) }} · {{ when(s.updatedAt) }}</span>
          </span>
        </button>
      </li>
    </ul>

    <p v-if="!sessions.length && !projectsStore.loadingSessions" class="empty">
      No chats yet.
    </p>

    <button class="fab" :disabled="creating" @click="newChat">
      {{ creating ? "…" : "+" }}
    </button>
  </div>
</template>

<style scoped>
.screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 10px;
}

header h1 {
  margin: 0;
  font-size: 22px;
}

.actions {
  display: flex;
  gap: 6px;
}

.actions button {
  /* 44px floor — these were 40 and sit right at the top edge, which is the
     hardest part of a phone screen to hit accurately. */
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 18px;
}

.list {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 0 0 120px;
  list-style: none;
  -webkit-overflow-scrolling: touch;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  /* 60px tall: a list row is the most-tapped target in the app and the platform
     floor for a comfortable one is ~48px. */
  min-height: 60px;
  padding: 10px 18px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  text-align: left;
}

.row:active {
  background: var(--bg-raised);
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: transparent;
}

.dot.working {
  background: var(--warn-fg);
  animation: pulse 1.4s ease-in-out infinite;
}

.dot.unread {
  background: var(--ok);
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

.body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.title {
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 12px;
  color: var(--fg-dim);
}

.empty,
.error {
  padding: 24px 18px;
  color: var(--fg-dim);
}

.error {
  color: var(--bad);
}

.fab {
  position: fixed;
  right: 20px;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);
  width: 56px;
  height: 56px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 28px;
  line-height: 1;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
}
</style>

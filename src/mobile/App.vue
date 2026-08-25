<script setup>
// The whole mobile shell: three screens and the two blocking gates.
//
// Navigation is a single `screen` ref, not a router. There are exactly three
// places to be and the back affordance is always "up one" — a router would be
// more machinery than the app has states.
import { computed, onMounted, ref } from "vue";
import { connectionStore } from "../stores/ssh.js";
import { initOpenCode, opencodeStore } from "../stores/opencode.js";
import { initProjects, projectsStore } from "../stores/projects.js";
import { permissionStore } from "../stores/permission.js";
import { questionStore } from "../stores/question.js";
import ConnectScreen from "./components/ConnectScreen.vue";
import SessionListScreen from "./components/SessionListScreen.vue";
import ChatScreen from "./components/ChatScreen.vue";
import PermissionSheet from "./components/PermissionSheet.vue";
import QuestionSheet from "./components/QuestionSheet.vue";

const screen = ref("connect"); // "connect" | "sessions" | "chat"
const booting = ref(true);

// The gates are modal over whatever screen is up: an agent that asked for
// permission is stopped until it gets an answer, so nothing else on screen
// matters until then. Permission wins a tie — it is the one that blocks a tool
// call mid-run, while a question is the agent's own turn.
const permissionAsk = computed(() => permissionStore.queue[0] || null);
const questionAsk = computed(() => (permissionAsk.value ? null : questionStore.queue[0] || null));

// Boot straight into the app when there is a saved connection that still
// answers, and fall back to the connect screen when there isn't. Anything else
// (a phone that changed networks, a server that moved) shows the connect screen
// with the previous values still filled in, which is the only useful place to
// be when the app can't reach anything.
async function boot() {
  booting.value = true;
  await initOpenCode();
  if (!opencodeStore.connected) {
    screen.value = "connect";
    booting.value = false;
    return;
  }
  await initProjects();
  screen.value = opencodeStore.activeSessionId ? "chat" : "sessions";
  booting.value = false;
}

async function onConnected() {
  await boot();
  if (opencodeStore.connected) screen.value = "sessions";
}

onMounted(boot);
</script>

<template>
  <div class="app">
    <div v-if="booting" class="boot">
      <div class="spinner" />
      <p>Connecting to {{ connectionStore.host }}:{{ connectionStore.port }}…</p>
    </div>

    <template v-else>
      <ConnectScreen v-if="screen === 'connect'" @connected="onConnected" />
      <SessionListScreen
        v-else-if="screen === 'sessions'"
        @open="screen = 'chat'"
        @settings="screen = 'connect'"
      />
      <ChatScreen v-else @back="screen = 'sessions'" />
    </template>

    <PermissionSheet v-if="permissionAsk" :ask="permissionAsk" />
    <QuestionSheet v-else-if="questionAsk" :ask="questionAsk" />

    <!-- Offline banner. The stream drops on every screen lock, so this has to be
         a passive notice rather than anything that steals focus or navigates. -->
    <div v-if="!booting && !opencodeStore.connected && screen !== 'connect'" class="offline">
      Disconnected — reconnecting…
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.boot {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--fg-dim);
}

.spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.offline {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 76px);
  margin: 0 auto;
  width: fit-content;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--warn-bg);
  color: var(--warn-fg);
  font-size: 13px;
  z-index: 40;
}
</style>

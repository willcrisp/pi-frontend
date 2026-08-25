<script setup>
// The whole mobile shell: three screens and the two blocking gates.
//
// Navigation is a single `screen` ref, not a router. There are exactly three
// places to be and the back affordance is always "up one" — a router would be
// more machinery than the app has states.
//
// It is mirrored into the History API all the same, because Android's back
// gesture is not optional. A WebView with no history entries takes the system
// back straight to "close the app", so opening a chat and swiping back would
// quit rather than return to the list — the first thing anyone tries, and it
// looked like a crash. Pushing a state per screen makes the hardware back and
// the on-screen ‹ do the same thing, which is the actual expectation.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { connectionStore } from "../stores/ssh.js";
import {
  initOpenCode,
  opencodeStore,
  reconnectStream,
  refreshActiveMessages,
} from "../stores/opencode.js";
import { fetchSessions, initProjects, projectsStore } from "../stores/projects.js";
import { setAppVisible, startWatching } from "./lib/nativeWatch.js";
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
  syncHistory();
  // Hand the connection to the native watcher, which keeps its own stream open
  // while the app is backgrounded and the WebView is frozen. A no-op off-device.
  startWatching(document.visibilityState === "visible");
}

// Put the history stack where `screen` ended up. Needed because boot restores
// the last chat directly: the watch below is suppressed while booting, so
// without this the app would sit on a chat with the list nowhere behind it and
// the system back would close the app instead of going up a level.
function syncHistory() {
  history.replaceState({ screen: "sessions" }, "");
  if (screen.value === "chat") history.pushState({ screen: "chat" }, "");
}

async function onConnected() {
  await boot();
  if (opencodeStore.connected) screen.value = "sessions";
}

// ── Android back ───────────────────────────────────────────────────────────
// One history entry per screen deeper than the list. `screen` stays the source
// of truth; history only mirrors it, and popstate is the only thing that reads
// back from it.
let syncingHistory = false;

watch(screen, (now, before) => {
  if (syncingHistory || booting.value) return;
  // Going deeper pushes; coming back up is handled by popstate itself.
  if (before === "sessions" && now === "chat") history.pushState({ screen: "chat" }, "");
});

function onPopState() {
  // Anything modal swallows the press first: a gate is a question the agent is
  // blocked on, and dismissing the screen behind it would leave it stranded.
  if (permissionAsk.value || questionAsk.value) {
    history.pushState({ screen: screen.value }, "");
    return;
  }
  if (screen.value === "chat") {
    syncingHistory = true;
    screen.value = "sessions";
    syncingHistory = false;
  }
  // At the list there is no entry left, so the system takes the press and
  // closes the app — which is what back at the root should do.
}

// ── Coming back to the app ─────────────────────────────────────────────────
// Android freezes the WebView when the app is backgrounded, and the SSE
// connection does not survive it. Nothing noticed: the app came back looking
// connected and simply never received another event, so a finished turn stayed
// "working" until it was force-quit. Re-establish the stream and re-read what
// was missed, rather than trusting what is on screen.
function onVisibility() {
  const visible = document.visibilityState === "visible";
  // Told on the way out as well as the way in: the service stays silent while
  // the app is on screen, and this is the only signal it gets.
  setAppVisible(visible);
  if (!visible) return;
  if (booting.value || screen.value === "connect") return;
  reconnectStream();
  fetchSessions().catch(() => {});
  if (opencodeStore.activeSessionId) refreshActiveMessages().catch(() => {});
}

onMounted(() => {
  // A base entry to pop back to, so the first push has somewhere to return.
  // boot() calls syncHistory() again once it knows which screen it landed on.
  history.replaceState({ screen: "sessions" }, "");
  window.addEventListener("popstate", onPopState);
  document.addEventListener("visibilitychange", onVisibility);
  boot();
});

onUnmounted(() => {
  window.removeEventListener("popstate", onPopState);
  document.removeEventListener("visibilitychange", onVisibility);
});
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

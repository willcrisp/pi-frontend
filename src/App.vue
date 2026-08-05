<!--
  App.vue: Top-level layout for OpenCode V2 web frontend.
  Owns the boot sequence: health-test the saved connection before
  initializing any stores, so no /api requests fire against an
  unreachable server.
-->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import {
  opencodeStore,
  initOpenCode,
  commitRevert,
  clearRevert,
  loadCatalogs,
  reconnectStream,
} from "./stores/opencode.js";
import { activeSessionDirectory, initProjects } from "./stores/projects.js";
import { loadLocalCommands } from "./stores/localCommands.js";
import { connectionStore, testConnection } from "./stores/ssh.js";
import { permissionStore } from "./stores/permission.js";
import { questionStore } from "./stores/question.js";
import ChatHeader from "./components/chat/ChatHeader.vue";
import Composer from "./components/chat/Composer.vue";
import MessageList from "./components/chat/MessageList.vue";
import Sidebar from "./components/sidebar/Sidebar.vue";
import ConnectScreen from "./components/dialogs/ConnectDialog.vue";
import PermissionDialog from "./components/dialogs/PermissionDialog.vue";
import QuestionDialog from "./components/dialogs/QuestionDialog.vue";
import FilePreview from "./components/chat/FilePreview.vue";
import CommandPalette from "./components/dialogs/CommandPalette.vue";
import ShortcutsDialog from "./components/dialogs/ShortcutsDialog.vue";
import ConfirmDialog from "./components/dialogs/ConfirmDialog.vue";
import { confirmStore } from "./stores/confirm.js";
import ProvidersDialog from "./components/dialogs/ProvidersDialog.vue";
import HandoverDialog from "./components/dialogs/HandoverDialog.vue";
import { handoverStore } from "./stores/handover.js";
import { toggleSidebar } from "./stores/layout.js";

const showProviders = ref(false);

// The queue head can be answered inline in the transcript when its tool
// call part is on screen (QuestionPart.vue). The modal is the fallback for
// asks from a different session, a sub-agent's turn, or a part the stream
// never delivered.
const inlineQuestion = computed(() => {
  const head = questionStore.queue[0];
  const callID = head && head.tool && head.tool.callID;
  if (!callID) return false;
  return opencodeStore.messages.some(
    (m) =>
      Array.isArray(m.parts) &&
      m.parts.some((p) => p.type === "tool" && p.callID === callID)
  );
});

async function boot() {
  connectionStore.status = "connecting";
  const ok = await testConnection(connectionStore.port);
  if (!ok) {
    connectionStore.status = "failed";
    return;
  }
  connectionStore.status = "connected";
  await initOpenCode();
  await initProjects();
  loadLocalCommands().catch((err) => console.warn("Could not load local commands:", err));
}

watch(
  activeSessionDirectory,
  (directory, previousDirectory) => {
    if (directory && directory !== previousDirectory) {
      loadLocalCommands().catch((err) => console.warn("Could not load local commands:", err));
    }
  }
);

// The empty state's escape hatch when the catalogs couldn't be fetched: a fresh
// set of retry attempts, so the user never has to reload the page by hand.
function retryCatalogs() {
  loadCatalogs({ force: true });
}

function onReconnect() {
  opencodeStore.error = null;
  reconnectStream();
  loadCatalogs({ force: true });
  loadLocalCommands().catch((err) => console.warn("Could not load local commands:", err));
}

onMounted(() => {
  boot();
});
</script>

<template>
  <ConnectScreen v-if="connectionStore.status !== 'connected'" @connect="boot" />

  <template v-else>
    <PermissionDialog v-if="permissionStore.queue.length" />
    <QuestionDialog v-else-if="questionStore.queue.length && !inlineQuestion" />
    <FilePreview />
    <!-- Owns its own Ctrl/Cmd+K listener, so it mounts unconditionally. -->
    <CommandPalette />
    <!-- Same: owns the "?" listener, and must work with no session open. -->
    <ShortcutsDialog />
    <ConfirmDialog v-if="confirmStore.open" />
    <!-- Opened by a handover chip in the transcript, and keyed by its id so it
         mounts fresh (empty notes box) per handover. -->
    <HandoverDialog v-if="handoverStore.openId" :key="handoverStore.openId" />
    <Sidebar />

    <!-- First run has no credentials and no sessions, and the only way to add
         a provider used to be a gear icon in the sidebar you had to know
         about. Surface it here when no model is available.

         ⚠️ Nothing may be inserted between this v-if and its v-else below.
         A ProvidersDialog used to sit in the gap, and Vue bound the v-else to
         *that* element's v-if instead: the chat panel became the dialog's
         else-branch, so it rendered alongside this empty state whenever no
         session was open, and unmounted whenever the dialog was open. The
         dialog is now mounted after the pair. -->
    <div v-if="!opencodeStore.activeSessionId" class="chat-panel chat-empty">
      <!-- ChatHeader isn't mounted here, so the empty state needs its own way to
           reach the drawer — otherwise the narrow layout has no route to the
           session list at exactly the moment you need one. -->
      <div class="chat-empty-header">
        <button
          type="button"
          class="sidebar-toggle"
          title="Sessions"
          aria-label="Show the session list"
          @click="toggleSidebar"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.5 4h11M2.5 8h11M2.5 12h11"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <p>Select or create an OpenCode session to start chatting</p>
      <!-- "No models" and "couldn't ask for models" look identical in this
           empty state, and telling someone to connect a provider they already
           have is worse than saying nothing. catalogFailed tells them apart. -->
      <template v-if="opencodeStore.catalogFailed">
        <p class="chat-empty-hint">
          Couldn't load the model list from the server. It may still be starting up.
        </p>
        <button type="button" @click="retryCatalogs">Try again</button>
      </template>
      <template v-else-if="!opencodeStore.availableModels.length">
        <p class="chat-empty-hint">
          No models available yet — connect a provider to get started.
        </p>
        <button type="button" @click="showProviders = true">Add a provider</button>
      </template>
    </div>

    <div v-else class="chat-panel">
      <ChatHeader />
      <div v-if="opencodeStore.error" class="process-error-banner">
        <span class="process-error-text">
          {{ opencodeStore.error }}
        </span>
        <button v-if="!opencodeStore.connected" type="button" class="process-error-retry" @click="onReconnect">Reconnect</button>
        <button type="button" class="process-error-dismiss" title="Dismiss" @click="opencodeStore.error = null">×</button>
      </div>
      <!-- A staged revert is a preview: the transcript below already reflects
           it, but nothing is permanent until committed. Both exits stay on
           screen for as long as it's staged. -->
      <div v-if="opencodeStore.revertStaged" class="revert-banner">
        <span>Revert staged — messages after this point are hidden.</span>
        <button type="button" @click="commitRevert">Keep revert</button>
        <button type="button" class="connect-secondary" @click="clearRevert">Undo</button>
      </div>
      <MessageList />
      <Composer />
    </div>

    <!-- Mounted after the v-if/v-else pair above, never between them. -->
    <ProvidersDialog v-if="showProviders" @close="showProviders = false" />
  </template>
</template>

<style scoped>
.chat-empty-hint {
  color: var(--dim);
  font-size: 13px;
}


.revert-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  font-size: 12px;
}

.revert-banner span {
  flex: 1;
}

.revert-banner button {
  font-size: 12px;
  padding: 2px 8px;
}
</style>

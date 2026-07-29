<!--
  App.vue: Top-level layout for OpenCode V2 web frontend.
  Owns the boot sequence: health-test the saved connection before
  initializing any stores, so no /api requests fire against an
  unreachable server.
-->
<script setup>
import { onMounted, ref } from "vue";
import { opencodeStore, initOpenCode, commitRevert, clearRevert } from "./stores/opencode.js";
import { initProjects } from "./stores/projects.js";
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

const showProviders = ref(false);

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
}

onMounted(() => {
  boot();
});
</script>

<template>
  <ConnectScreen v-if="connectionStore.status !== 'connected'" @connect="boot" />

  <template v-else>
    <PermissionDialog v-if="permissionStore.queue.length" />
    <QuestionDialog v-else-if="questionStore.queue.length" />
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
         about. Surface it here when no model is available. -->
    <div v-if="!opencodeStore.activeSessionId" class="chat-panel chat-empty">
      <p>Select or create an OpenCode session to start chatting</p>
      <template v-if="!opencodeStore.availableModels.length">
        <p class="chat-empty-hint">
          No models available yet — connect a provider to get started.
        </p>
        <button type="button" @click="showProviders = true">Add a provider</button>
      </template>
    </div>
    <ProvidersDialog v-if="showProviders" @close="showProviders = false" />

    <div v-else class="chat-panel">
      <ChatHeader />
      <div v-if="opencodeStore.error" class="process-error-banner">
        <span class="process-error-text">
          {{ opencodeStore.error }}
        </span>
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

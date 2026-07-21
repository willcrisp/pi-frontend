<script setup>
import { projectsStore } from "./stores/projects.js";
import { authStore } from "./stores/auth.js";
import { agentsStore } from "./stores/agents.js";
import { renameDialogStore } from "./stores/renameDialog.js";
import { dismissUiNotice, store } from "./stores/pi.js";
import ChatHeader from "./components/chat/ChatHeader.vue";
import Composer from "./components/chat/Composer.vue";
import MessageList from "./components/chat/MessageList.vue";
import Sidebar from "./components/sidebar/Sidebar.vue";
import ConnectDialog from "./components/dialogs/ConnectDialog.vue";
import AgentsDialog from "./components/dialogs/AgentsDialog.vue";
import RenameDialog from "./components/dialogs/RenameDialog.vue";
import SshPopover from "./components/popovers/SshPopover.vue";
import ExtensionUIDialog from "./components/dialogs/ExtensionUIDialog.vue";
import CoderMenu from "./components/popovers/CoderMenu.vue";
import CommandPalette from "./components/dialogs/CommandPalette.vue";
</script>

<template>
  <Sidebar />

  <div v-if="!projectsStore.currentProjectId" class="chat-panel chat-empty">
    <div class="chat-empty-header">
      <SshPopover />
      <CoderMenu />
    </div>
    <p>select or add a project to start chatting</p>
  </div>

  <div v-else class="chat-panel">
    <ChatHeader />
    <div v-if="store.processError" class="process-error-banner">
      <span class="process-error-text">
        pi process failed to start<template v-if="store.processError.exitCode != null"> (exit {{ store.processError.exitCode }})</template>: {{ store.processError.message }}
      </span>
      <button type="button" class="process-error-dismiss" title="Dismiss" @click="store.processError = null">×</button>
    </div>
    <MessageList />
    <Composer />
  </div>

  <div v-if="store.uiNotices.length" class="ui-notices">
    <div
      v-for="n in store.uiNotices"
      :key="n.id"
      class="ui-notice"
      :class="n.notifyType"
      @click="dismissUiNotice(n.id)"
    >
      {{ n.message }}
    </div>
  </div>

  <CommandPalette />
  <ExtensionUIDialog v-if="store.uiRequests.length" />
  <ConnectDialog v-if="authStore.open" />
  <AgentsDialog v-if="agentsStore.open" />
  <RenameDialog v-if="renameDialogStore.open" />
</template>

<script setup>
import { projectsStore } from "./projects.js";
import { authStore } from "./auth.js";
import { agentsStore } from "./agents.js";
import { renameDialogStore } from "./renameDialog.js";
import { dismissUiNotice, store } from "./pi.js";
import ChatHeader from "./ChatHeader.vue";
import Composer from "./Composer.vue";
import MessageList from "./MessageList.vue";
import Sidebar from "./Sidebar.vue";
import ConnectDialog from "./ConnectDialog.vue";
import AgentsDialog from "./AgentsDialog.vue";
import RenameDialog from "./RenameDialog.vue";
import SshPopover from "./SshPopover.vue";
import ExtensionUIDialog from "./ExtensionUIDialog.vue";
import CoderMenu from "./CoderMenu.vue";
import CommandPalette from "./CommandPalette.vue";
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

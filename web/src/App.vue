<script setup>
import { projectsStore } from "./projects.js";
import { authStore } from "./auth.js";
import { store } from "./pi.js";
import ChatHeader from "./ChatHeader.vue";
import Composer from "./Composer.vue";
import MessageList from "./MessageList.vue";
import Sidebar from "./Sidebar.vue";
import ConnectDialog from "./ConnectDialog.vue";
</script>

<template>
  <Sidebar />

  <div v-if="!projectsStore.currentProjectId" class="chat-panel chat-empty">
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

  <ConnectDialog v-if="authStore.open" />
</template>

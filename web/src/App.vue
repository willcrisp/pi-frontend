<script setup>
import { projectsStore } from "./projects.js";
import { authStore } from "./auth.js";
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
    <MessageList />
    <Composer />
  </div>

  <ConnectDialog v-if="authStore.open" />
</template>

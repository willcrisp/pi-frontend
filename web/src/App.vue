<!--
  App.vue: Top-level layout for OpenCode V2 web frontend.
-->
<script setup>
import { opencodeStore } from "./stores/opencode.js";
import ChatHeader from "./components/chat/ChatHeader.vue";
import Composer from "./components/chat/Composer.vue";
import MessageList from "./components/chat/MessageList.vue";
import Sidebar from "./components/sidebar/Sidebar.vue";
import CoderMenu from "./components/popovers/CoderMenu.vue";
</script>

<template>
  <Sidebar />

  <div v-if="!opencodeStore.activeSessionId" class="chat-panel chat-empty">
    <div class="chat-empty-header">
      <CoderMenu />
    </div>
    <p>Select or create an OpenCode session to start chatting</p>
  </div>

  <div v-else class="chat-panel">
    <ChatHeader />
    <div v-if="opencodeStore.error" class="process-error-banner">
      <span class="process-error-text">
        {{ opencodeStore.error }}
      </span>
      <button type="button" class="process-error-dismiss" title="Dismiss" @click="opencodeStore.error = null">×</button>
    </div>
    <MessageList />
    <Composer />
  </div>
</template>

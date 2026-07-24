<!--
  App.vue: Top-level layout for OpenCode V2 web frontend.
  Owns the boot sequence: health-test the saved connection before
  initializing any stores, so no /api requests fire against an
  unreachable server.
-->
<script setup>
import { onMounted } from "vue";
import { opencodeStore, initOpenCode } from "./stores/opencode.js";
import { initProjects } from "./stores/projects.js";
import { connectionStore, testConnection } from "./stores/ssh.js";
import ChatHeader from "./components/chat/ChatHeader.vue";
import Composer from "./components/chat/Composer.vue";
import MessageList from "./components/chat/MessageList.vue";
import Sidebar from "./components/sidebar/Sidebar.vue";
import ConnectScreen from "./components/dialogs/ConnectDialog.vue";

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
    <Sidebar />

    <div v-if="!opencodeStore.activeSessionId" class="chat-panel chat-empty">
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
</template>

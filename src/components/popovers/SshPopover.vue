<!--
  Click-toggled popup for configuring OpenCode V2 SSH forwarding / remote server targets.
-->
<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import { connectionStore, testConnection, setConnection, setCredentials } from "../../stores/ssh.js";

const root = ref(null);
const open = ref(false);
const portInput = ref(connectionStore.port);
const username = ref(connectionStore.username);
const password = ref(connectionStore.password);

function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) {
    open.value = false;
  }
}

function onKeydown(e) {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});

async function onTest() {
  setCredentials(username.value, password.value);
  await testConnection(portInput.value, username.value, password.value);
}

function onSave() {
  setConnection(portInput.value);
  setCredentials(username.value, password.value);
  open.value = false;
  window.location.reload();
}
</script>

<template>
  <div ref="root" class="ssh-trigger-wrap">
    <button
      type="button"
      class="ssh-trigger"
      :title="store.connected ? (store.isStreaming ? 'Connected · agent running' : 'Connected') : 'Disconnected'"
      @click="open = !open"
    >
      <span class="dot" :class="{ connected: store.connected, streaming: store.isStreaming }"></span>
    </button>

    <div class="ssh-popover-panel" :class="{ open }">
      <div class="ssh-status usage-dim">
        OpenCode: 127.0.0.1:{{ connectionStore.port }} ({{ connectionStore.mode }})
      </div>

      <input
        v-model.number="portInput"
        type="number"
        min="1"
        max="65535"
        placeholder="4096"
        autocomplete="off"
        spellcheck="false"
      />

      <input
        v-model="username"
        type="text"
        placeholder="opencode"
        autocomplete="off"
        spellcheck="false"
      />

      <input
        v-model="password"
        type="password"
        placeholder="password"
        autocomplete="off"
        spellcheck="false"
      />

      <div class="ssh-actions">
        <button type="button" :disabled="!portInput || connectionStore.testing" @click="onTest">
          {{ connectionStore.testing ? "Testing…" : "Test Connection" }}
        </button>
        <button type="button" :disabled="!portInput" @click="onSave">
          Save &amp; Connect
        </button>
      </div>

      <div v-if="connectionStore.testResult" class="ssh-test-result" :class="connectionStore.testResult.ok ? 'ok' : 'fail'">
        {{ connectionStore.testResult.message }}
      </div>

      <div class="usage-dim ssh-help">
        For SSH remote workspaces, forward the remote server to a local port first (`ssh -L 5000:localhost:4096 user@host`), then enter that port here.
      </div>
    </div>
  </div>
</template>

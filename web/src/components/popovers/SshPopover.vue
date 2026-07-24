<!--
  Click-toggled popup for configuring OpenCode V2 SSH forwarding / remote server targets.
-->
<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import { sshStore, testTargetUrl, setTargetUrl } from "../../stores/ssh.js";

const root = ref(null);
const open = ref(false);
const targetUrlInput = ref(sshStore.targetUrl);

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
  await testTargetUrl(targetUrlInput.value);
}

function onSave() {
  setTargetUrl(targetUrlInput.value);
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
        OpenCode Target: {{ sshStore.targetUrl }}
      </div>

      <input
        v-model="targetUrlInput"
        type="text"
        placeholder="http://127.0.0.1:4096"
        autocomplete="off"
        spellcheck="false"
      />

      <div class="ssh-actions">
        <button type="button" :disabled="!targetUrlInput.trim() || sshStore.testing" @click="onTest">
          {{ sshStore.testing ? "Testing…" : "Test Connection" }}
        </button>
        <button type="button" :disabled="!targetUrlInput.trim()" @click="onSave">
          Save &amp; Connect
        </button>
      </div>

      <div v-if="sshStore.testResult" class="ssh-test-result" :class="sshStore.testResult.ok ? 'ok' : 'fail'">
        {{ sshStore.testResult.message }}
      </div>

      <div class="usage-dim ssh-help">
        For SSH remote workspaces, forward port 4096 (`ssh -L 4096:localhost:4096 user@host`) or enter direct endpoint.
      </div>
    </div>
  </div>
</template>

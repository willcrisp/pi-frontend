<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import { store } from "../../stores/pi.js";
import { sshStore, fetchSshConfig, testSshConfig, saveSshConfig, clearSshConfig } from "../../stores/ssh.js";

const root = ref(null);
const open = ref(false);
const formHost = ref("");
const formIdentity = ref("");
const formPort = ref("");

function resetForm() {
  formHost.value = sshStore.host || "";
  formIdentity.value = sshStore.identity || "";
  formPort.value = sshStore.port ? String(sshStore.port) : "";
}

watch(open, async (isOpen) => {
  if (!isOpen) return;
  await fetchSshConfig();
  resetForm();
});

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
  await testSshConfig({ host: formHost.value.trim(), identity: formIdentity.value.trim(), port: formPort.value ? Number(formPort.value) : null });
}

async function onSave() {
  try {
    await saveSshConfig({ host: formHost.value.trim(), identity: formIdentity.value.trim(), port: formPort.value ? Number(formPort.value) : null });
    open.value = false;
  } catch {
    // sshStore.error is shown inline; keep the popover open.
  }
}

async function onClear() {
  if (!confirm("Switch back to local execution? Every project's running chat will be restarted.")) return;
  try {
    await clearSshConfig();
    resetForm();
  } catch {
    // sshStore.error is shown inline.
  }
}
</script>

<template>
  <div ref="root" class="ssh-trigger-wrap">
    <button
      type="button"
      class="ssh-trigger"
      :title="store.connected ? (store.streaming ? 'Connected · agent running' : 'Connected') : 'Disconnected'"
      @click="open = !open"
    >
      <span class="dot" :class="{ connected: store.connected, streaming: store.streaming }"></span>
    </button>

    <div class="ssh-popover-panel" :class="{ open }">
      <div class="ssh-status usage-dim">
        {{ sshStore.host ? `remote: ${sshStore.host}` : "local execution" }}
      </div>

      <input v-model="formHost" type="text" placeholder="user@host" autocomplete="off" spellcheck="false" />
      <input v-model="formIdentity" type="text" placeholder="~/.ssh/id_ed25519 (optional)" autocomplete="off" spellcheck="false" />
      <input v-model="formPort" type="number" placeholder="22" min="1" max="65535" />

      <div class="ssh-actions">
        <button type="button" :disabled="!formHost.trim() || sshStore.testing" @click="onTest">
          {{ sshStore.testing ? "Testing…" : "Test Connection" }}
        </button>
        <button type="button" :disabled="!formHost.trim() || sshStore.saving" @click="onSave">
          {{ sshStore.saving ? "Saving…" : "Save" }}
        </button>
      </div>

      <div v-if="sshStore.testResult" class="ssh-test-result" :class="sshStore.testResult.ok ? 'ok' : 'fail'">
        {{ sshStore.testResult.message }}
      </div>
      <div v-if="sshStore.testResult && sshStore.testResult.piFound === false" class="usage-dim">
        pi not found on remote PATH yet
      </div>
      <div v-if="sshStore.error" class="ssh-test-result fail">{{ sshStore.error }}</div>

      <button v-if="sshStore.host" type="button" class="ssh-clear-link" :disabled="sshStore.clearing" @click="onClear">
        {{ sshStore.clearing ? "Switching…" : "Use local execution" }}
      </button>

      <div class="usage-dim ssh-help">Applies to all projects · saving restarts every project's session</div>
    </div>
  </div>
</template>

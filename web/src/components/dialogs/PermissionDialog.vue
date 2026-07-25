<!--
  Modal for approving/denying a tool call that needs permission. Backed by
  stores/permission.js — permissionStore.queue is a FIFO of pending requests;
  this dialog always shows the queue head and advances automatically as
  responses come back (see App.vue, which mounts this while the queue is
  non-empty).
-->
<script setup>
import { computed } from "vue";
import { permissionStore, respond } from "../../stores/permission.js";

const current = computed(() => permissionStore.queue[0] || null);

const argumentsJson = computed(() => {
  if (!current.value) return "";
  try {
    return JSON.stringify(current.value.arguments, null, 2);
  } catch {
    return String(current.value.arguments);
  }
});

function respondCurrent(response) {
  if (!current.value) return;
  respond(current.value.id, response);
}
</script>

<template>
  <div v-if="current" class="connect-backdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Permission requested</span>
      </div>

      <p v-if="current.error" class="connect-error">{{ current.error }}</p>

      <div class="connect-hint">
        Tool <strong>{{ current.tool }}</strong> wants to run:
      </div>
      <pre class="permission-arguments">{{ argumentsJson }}</pre>

      <div class="connect-actions">
        <button type="button" @click="respondCurrent('once')">Allow once</button>
        <button type="button" @click="respondCurrent('always')">Allow always</button>
        <button type="button" class="connect-secondary" @click="respondCurrent('reject')">Deny</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.permission-arguments {
  max-height: 240px;
  overflow: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

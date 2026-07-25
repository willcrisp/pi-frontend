<!--
  Modal for approving/denying a tool call that needs permission. Backed by
  stores/permission.js — permissionStore.queue is a FIFO of pending requests
  from `permission.v2.asked`; this dialog always shows the queue head and
  advances automatically as replies come back (see App.vue, which mounts
  this while the queue is non-empty).
-->
<script setup>
import { computed } from "vue";
import { permissionStore, respond } from "../../stores/permission.js";

const current = computed(() => permissionStore.queue[0] || null);

const metadataJson = computed(() => {
  if (!current.value) return "";
  const meta = current.value.metadata;
  if (!meta || !Object.keys(meta).length) return "";
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return String(meta);
  }
});

function respondCurrent(reply) {
  if (!current.value) return;
  respond(current.value.id, reply);
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
        Action: <strong>{{ current.action }}</strong>
      </div>
      <ul v-if="current.resources.length" class="permission-resources">
        <li v-for="r in current.resources" :key="r">{{ r }}</li>
      </ul>
      <pre v-if="metadataJson" class="permission-metadata">{{ metadataJson }}</pre>

      <div class="connect-actions">
        <button type="button" @click="respondCurrent('once')">Allow once</button>
        <button type="button" @click="respondCurrent('always')">Allow always</button>
        <button type="button" class="connect-secondary" @click="respondCurrent('reject')">Deny</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.permission-resources {
  margin: 6px 0 8px;
  padding: 6px 10px;
  list-style: none;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 12px;
  max-height: 140px;
  overflow: auto;
}

.permission-resources li {
  padding: 1px 0;
  word-break: break-all;
}

.permission-metadata {
  max-height: 200px;
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

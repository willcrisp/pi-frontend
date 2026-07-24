<!--
  Modal for viewing and selecting agents available in OpenCode V2.
  Agents are managed server-side; this dialog lists them from /api/agent.
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import { opencodeStore, loadAgents, setAgent } from "../../stores/opencode.js";

const emit = defineEmits(["close"]);

const loading = ref(false);
const error = ref("");

onMounted(async () => {
  loading.value = true;
  try {
    await loadAgents();
  } catch (e) {
    error.value = e.message || "Failed to load agents";
  } finally {
    loading.value = false;
  }
});

function selectAgent(agentId) {
  setAgent(agentId);
  emit("close");
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) emit("close");
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Agents</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="error" class="connect-error">{{ error }}</p>

      <div v-if="loading" class="connect-hint">Loading agents…</div>

      <template v-else>
        <div v-if="!opencodeStore.availableAgents.length" class="connect-hint">
          No agents available from OpenCode V2 server.
        </div>
        <ul v-else class="agents-list">
          <li
            v-for="a in opencodeStore.availableAgents"
            :key="typeof a === 'object' ? a.id : a"
            class="agents-row"
            :class="{ active: (typeof a === 'object' ? a.id : a) === opencodeStore.selectedAgent }"
            @click="selectAgent(typeof a === 'object' ? a.id : a)"
          >
            <div class="agents-row-main">
              <span class="agents-name">{{ typeof a === 'object' ? (a.name || a.id) : a }}</span>
              <span v-if="typeof a === 'object' && a.description" class="agents-desc">{{ a.description }}</span>
            </div>
            <div class="agents-row-meta">
              <span v-if="(typeof a === 'object' ? a.id : a) === opencodeStore.selectedAgent" class="agents-chip">active</span>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

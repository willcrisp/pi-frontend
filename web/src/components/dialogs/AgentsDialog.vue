<!--
  Agent roster. Agents are defined server-side and V2 exposes them read-only
  (GET /api/agent — there is no CRUD route), so this dialog does two things
  and no more: switch the active session's primary agent, and show which
  sub-agents the `subagent` tool can dispatch. Sub-agents are listed but not
  selectable — they are dispatched by a tool call, never set as the session
  agent.
-->
<script setup>
import { onMounted, ref } from "vue";
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
          No agents available from the OpenCode server.
        </div>
        <ul v-else class="agents-list">
          <li
            v-for="a in opencodeStore.availableAgents"
            :key="a.id"
            class="agents-row"
            :class="{ active: a.id === opencodeStore.selectedAgent }"
            @click="selectAgent(a.id)"
          >
            <div class="agents-row-main">
              <span class="agents-name">{{ a.name || a.id }}</span>
              <span v-if="a.description" class="agents-desc">{{ a.description }}</span>
            </div>
            <div class="agents-row-meta">
              <span v-if="a.id === opencodeStore.selectedAgent" class="agents-chip">active</span>
            </div>
          </li>
        </ul>

        <template v-if="opencodeStore.subagentRoster.length">
          <div class="connect-hint">
            Sub-agents — dispatched by the <code>subagent</code> tool, not selectable here.
          </div>
          <ul class="agents-list">
            <li v-for="a in opencodeStore.subagentRoster" :key="a.id" class="agents-row readonly">
              <div class="agents-row-main">
                <span class="agents-name">{{ a.name || a.id }}</span>
                <span v-if="a.description" class="agents-desc">{{ a.description }}</span>
              </div>
              <div class="agents-row-meta">
                <span class="agents-chip">subagent</span>
              </div>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.agents-row.readonly {
  cursor: default;
}
</style>

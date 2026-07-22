<!--
  Click-toggled popup on a header trigger showing Serena monitoring status
  (serena.js — GET /api/serena/status): connection health, indexed
  projects, and per-tool call/token stats aggregated across every live
  dashboard instance. Modeled on SshPopover.vue (outside-click/Escape
  close, fetch-on-open via watch(open)) with CoderMenu.vue's light polling
  while open, since Serena instances come and go with pi processes.
-->
<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { serenaStore, fetchSerenaStatus } from "../../stores/serena.js";

const root = ref(null);
const open = ref(false);

const topTools = computed(() => serenaStore.toolStats.slice(0, 5));

const totals = computed(() =>
  serenaStore.toolStats.reduce(
    (acc, t) => {
      acc.calls += t.numTimesCalled || 0;
      acc.input += t.inputTokens || 0;
      acc.output += t.outputTokens || 0;
      return acc;
    },
    { calls: 0, input: 0, output: 0 }
  )
);

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(fetchSerenaStatus, 5000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

watch(open, (isOpen) => {
  if (isOpen) {
    fetchSerenaStatus();
    startPolling();
  } else {
    stopPolling();
  }
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
  stopPolling();
});
</script>

<template>
  <div ref="root" class="ssh-trigger-wrap">
    <button
      type="button"
      class="ssh-trigger"
      :title="serenaStore.connected ? 'Serena connected' : 'Serena not connected'"
      @click="open = !open"
    >
      <span class="dot" :class="{ connected: serenaStore.connected }"></span>
    </button>

    <div class="ssh-popover-panel serena-popover-panel" :class="{ open }">
      <div class="usage-row usage-total">
        <span>Serena</span>
        <strong>{{ serenaStore.connected ? `${serenaStore.instances.length} connected` : "not connected" }}</strong>
      </div>

      <template v-if="serenaStore.instances.length">
        <div v-for="inst in serenaStore.instances" :key="inst.port" class="usage-row usage-dim">
          <span>:{{ inst.port }} {{ inst.activeProject || "" }}</span>
          <span v-if="inst.toolCount != null">{{ inst.toolCount }} tools</span>
        </div>
      </template>

      <div class="usage-sep"></div>

      <div class="usage-row usage-heading">
        <span>Indexed projects</span>
        <strong>{{ serenaStore.indexedProjects.length }}</strong>
      </div>
      <div v-if="!serenaStore.indexedProjects.length" class="usage-row usage-dim">none found</div>
      <div v-for="p in serenaStore.indexedProjects" :key="p.name" class="usage-row usage-dim">
        <span>{{ p.name }}</span>
        <span>{{ p.languages.join(", ") }}</span>
      </div>

      <div class="usage-sep"></div>

      <div class="usage-row usage-heading">
        <span>Tool usage</span>
        <strong>{{ formatTokens(totals.input + totals.output) }} tok</strong>
      </div>
      <div v-if="!topTools.length" class="usage-row usage-dim">no calls yet</div>
      <div v-for="t in topTools" :key="t.name" class="usage-row usage-dim">
        <span>{{ t.name }}</span>
        <span>{{ t.numTimesCalled }}× · {{ formatTokens(t.inputTokens + t.outputTokens) }}</span>
      </div>
      <div v-if="serenaStore.tokenEstimator" class="usage-row usage-dim">
        <span>estimator</span>
        <span>{{ serenaStore.tokenEstimator }}</span>
      </div>

      <div v-if="serenaStore.error" class="ssh-test-result fail">{{ serenaStore.error }}</div>
    </div>
  </div>
</template>

<style scoped>
.serena-popover-panel {
  width: 280px;
  max-height: 360px;
  overflow-y: auto;
}
</style>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { coderStore, fetchWorkspaces, startWorkspace, stopWorkspace, isRunning, isBusy } from "../../stores/coder.js";

const root = ref(null);
const open = ref(false);
const actionError = ref("");

const runningCount = computed(() => coderStore.workspaces.filter(isRunning).length);

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(fetchWorkspaces, 4000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

watch(open, (isOpen) => {
  if (isOpen) {
    actionError.value = "";
    fetchWorkspaces();
    startPolling();
  } else {
    stopPolling();
  }
});

async function onToggle(ws) {
  actionError.value = "";
  try {
    if (isRunning(ws)) await stopWorkspace(ws.id);
    else await startWorkspace(ws.id);
  } catch (e) {
    actionError.value = e.message || String(e);
  }
}

function statusLabel(ws) {
  return coderStore.pending[ws.id] === "start"
    ? "starting…"
    : coderStore.pending[ws.id] === "stop"
      ? "stopping…"
      : ws.status;
}

function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false;
}
function onKeydown(e) {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
  // Initial fetch so the trigger reflects availability / running count.
  fetchWorkspaces();
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
  stopPolling();
});
</script>

<template>
  <div ref="root" class="coder-trigger-wrap">
    <button
      type="button"
      class="coder-trigger"
      :title="coderStore.available ? 'Coder workspaces' : 'Coder CLI not available'"
      @click="open = !open"
    >
      <span class="coder-label">coder</span>
      <span v-if="runningCount" class="coder-count">{{ runningCount }}</span>
    </button>

    <div class="coder-popover-panel" :class="{ open }">
      <div class="coder-head">
        <span class="coder-title">workspaces</span>
        <button type="button" class="coder-refresh" :disabled="coderStore.loading" @click="fetchWorkspaces" title="Refresh">
          {{ coderStore.loading ? "…" : "↻" }}
        </button>
      </div>

      <div v-if="!coderStore.available" class="coder-unavailable usage-dim">
        {{ coderStore.error || "coder CLI not found — install it and run `coder login`" }}
      </div>

      <template v-else>
        <div v-if="!coderStore.workspaces.length && coderStore.loaded" class="usage-dim">no workspaces</div>

        <div v-for="ws in coderStore.workspaces" :key="ws.id" class="coder-row">
          <span class="coder-ws-dot" :class="ws.status"></span>
          <div class="coder-ws-meta">
            <span class="coder-ws-name" :title="ws.id">{{ ws.name }}</span>
            <span class="coder-ws-status">{{ statusLabel(ws) }}<template v-if="ws.outdated"> · outdated</template></span>
          </div>
          <button
            type="button"
            class="coder-action"
            :class="isRunning(ws) ? 'stop' : 'start'"
            :disabled="isBusy(ws)"
            :title="isRunning(ws) ? `Stop ${ws.name}` : `Start ${ws.name}`"
            @click="onToggle(ws)"
          >
            <span v-if="isRunning(ws)" class="glyph-stop"></span>
            <span v-else class="glyph-start"></span>
          </button>
        </div>
      </template>

      <div v-if="actionError" class="coder-error">{{ actionError }}</div>
    </div>
  </div>
</template>

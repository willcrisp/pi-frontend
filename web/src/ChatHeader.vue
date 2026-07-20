<script setup>
import { computed } from "vue";
import { setSessionName, store, subagentDetails } from "./pi.js";
import UsagePopover from "./UsagePopover.vue";
import ColorProfilePopover from "./ColorProfilePopover.vue";
import SshPopover from "./SshPopover.vue";
import CoderMenu from "./CoderMenu.vue";

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);

const totalTokens = computed(() => {
  const n = store.sessionStats?.tokens?.total;
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
});

const titleText = computed(() => {
  const name = store.sessionName || "untitled";
  return totalTokens.value != null ? `${name} · ${totalTokens.value} tok` : name;
});

async function renameSession() {
  const next = window.prompt("Session name:", store.sessionName || "");
  if (next && next.trim()) {
    await setSessionName(next.trim());
  }
}

// Currently-running sub-agents across all tool calls in this project's chat,
// for the header badge. Counts individual dispatched tasks (not tool calls)
// when a details snapshot is available, falling back to 1 per still-running
// dispatch before its first snapshot arrives.
const subagentBadge = computed(() => {
  let count = 0;
  let firstId = null;
  for (const [id, r] of Object.entries(store.toolResults)) {
    if (!r.running) continue;
    const details = subagentDetails(r);
    if (r.name !== "subagent" && !details) continue;
    const n = details ? details.results.filter((res) => res.exitCode === -1).length : 1;
    count += n;
    if (n > 0 && !firstId) firstId = id;
  }
  return { count, firstId };
});

function scrollToRunningSubagent() {
  const id = subagentBadge.value.firstId;
  if (!id) return;
  document.getElementById(`tc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
</script>

<template>
  <header>
    <div class="header-left">
      <SshPopover />
      <span class="wordmark" title="pi coding agent">pi</span>
      <CoderMenu />
      <span :title="modelLabel">{{ modelLabel }}</span>
    </div>
    <button class="header-title" :title="'Rename session: ' + (store.sessionName || 'untitled')" @click="renameSession">
      {{ titleText }}
    </button>
    <div class="header-right">
      <button
        v-if="subagentBadge.count > 0"
        class="subagent-badge"
        type="button"
        title="Jump to running sub-agent"
        @click="scrollToRunningSubagent"
      >
        <span class="subagent-badge-dot"></span>
        {{ subagentBadge.count }} agent{{ subagentBadge.count === 1 ? "" : "s" }}
      </button>
      <UsagePopover class="header-usage" />
      <ColorProfilePopover />
    </div>
  </header>
</template>

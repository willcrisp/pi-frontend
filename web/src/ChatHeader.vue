<script setup>
import { computed } from "vue";
import { setSessionName, store } from "./pi.js";
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
      <UsagePopover class="header-usage" />
      <ColorProfilePopover />
    </div>
  </header>
</template>

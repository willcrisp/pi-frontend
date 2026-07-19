<script setup>
import { computed } from "vue";
import { store } from "./pi.js";
import UsagePopover from "./UsagePopover.vue";

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);
</script>

<template>
  <header>
    <span
      class="dot"
      :class="{ connected: store.connected, streaming: store.streaming }"
      :title="store.connected ? (store.streaming ? 'Connected · agent running' : 'Connected') : 'Disconnected'"
    ></span>
    <span class="wordmark" title="pi coding agent">pi</span>
    <span :title="modelLabel">{{ modelLabel }}</span>
    <span v-if="store.sessionName" :title="store.sessionName">· {{ store.sessionName }}</span>
    <UsagePopover class="header-usage" />
  </header>
</template>

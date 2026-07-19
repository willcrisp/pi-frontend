<script setup>
import { computed } from "vue";
import { store } from "./pi.js";
import UsagePopover from "./UsagePopover.vue";
import SshPopover from "./SshPopover.vue";

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);
</script>

<template>
  <header>
    <SshPopover />
    <span class="wordmark" title="pi coding agent">pi</span>
    <span :title="modelLabel">{{ modelLabel }}</span>
    <span v-if="store.sessionName" :title="store.sessionName">· {{ store.sessionName }}</span>
    <UsagePopover class="header-usage" />
  </header>
</template>

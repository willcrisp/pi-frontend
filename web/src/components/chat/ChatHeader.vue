<!--
  Top chat bar for OpenCode V2: connection indicator, active session title, model label, usage popover.
-->
<script setup>
import { computed } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import ColorProfilePopover from "../popovers/ColorProfilePopover.vue";
import CoderMenu from "../popovers/CoderMenu.vue";
import UsagePopover from "../popovers/UsagePopover.vue";

const connectionStatusClass = computed(() => (store.connected ? "active" : "offline"));
const modelLabel = computed(() => store.selectedModel || "OpenCode V2");
const sessionTitle = computed(() => store.activeSessionId ? `Session ${store.activeSessionId.slice(0, 8)}` : "OpenCode Harness");
</script>

<template>
  <header>
    <div class="header-left">
      <span class="status-dot" :class="connectionStatusClass" :title="store.connected ? 'OpenCode V2 Connected' : 'Disconnected'"></span>
      <span class="wordmark" title="OpenCode V2 AI Harness">opencode</span>
      <CoderMenu />
      <span class="dim">{{ modelLabel }}</span>
    </div>

    <div class="header-title">
      <span class="header-title-content">
        <span>{{ sessionTitle }}</span>
        <span v-if="store.isStreaming" class="dim"> · streaming…</span>
      </span>
    </div>

    <div class="header-right">
      <UsagePopover class="header-usage" />
      <ColorProfilePopover />
    </div>
  </header>
</template>

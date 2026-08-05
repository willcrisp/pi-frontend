<!--
  Read-only file viewer for paths referenced by tool calls (stores/
  filepreview.js). Deliberately not an editor: the agent owns the working
  tree, and a second writer would race it.
-->
<script setup>
import { previewStore, closePreview } from "../../stores/filepreview.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

// This used to be `@keydown` on the backdrop <div> with `tabindex="-1"`, which
// only worked while something inside happened to hold focus — clicking the
// backdrop once killed it. Mounted permanently, so `open` decides.
const { onBackdrop } = useDialogEscape(() => closePreview(), {
  open: () => previewStore.open,
});
</script>

<template>
  <div v-if="previewStore.open" class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel file-preview-panel">
      <div class="connect-head">
        <span class="file-preview-path" :title="previewStore.path">{{ previewStore.path }}</span>
        <button class="connect-close" title="Close" @click="closePreview">✕</button>
      </div>

      <p v-if="previewStore.error" class="connect-error">{{ previewStore.error }}</p>
      <div v-else-if="previewStore.loading" class="connect-hint">Loading…</div>
      <pre v-else class="file-preview-body">{{ previewStore.content }}</pre>
    </div>
  </div>
</template>

<style scoped>
.file-preview-panel {
  width: min(900px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.file-preview-path {
  font-family: var(--mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-preview-body {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre;
}
</style>

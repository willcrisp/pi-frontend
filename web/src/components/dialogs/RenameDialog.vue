<!--
  Small modal for renaming the active session. On success, refreshes
  the sidebar's session list immediately.
-->
<script setup>
import { nextTick, onMounted, ref } from "vue";
import { closeRenameDialog } from "../../stores/renameDialog.js";

const value = ref("");
const inputEl = ref(null);
const busy = ref(false);

onMounted(() => {
  nextTick(() => inputEl.value?.focus());
});

// The V2 HttpApi in this build has no PATCH /session/{id} — rename would
// 404. Left as a no-op close until the server exposes a rename route.
async function confirm() {
  closeRenameDialog();
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) closeRenameDialog();
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel rename-panel">
      <div class="connect-head">
        <span>Rename session</span>
        <button class="connect-close" title="Close" @click="closeRenameDialog">✕</button>
      </div>
      <form @submit.prevent="confirm">
        <input
          ref="inputEl"
          v-model="value"
          class="connect-filter"
          placeholder="Session name…"
          :disabled="busy"
          @keydown.escape="closeRenameDialog"
        />
        <div class="connect-actions">
          <button type="submit" :disabled="busy || !value.trim()">Rename</button>
          <button type="button" class="connect-secondary" @click="closeRenameDialog">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</template>

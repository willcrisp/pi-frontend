<script setup>
import { nextTick, onMounted, ref } from "vue";
import { setSessionName, store } from "./pi.js";
import { refreshCurrentSessions } from "./projects.js";
import { closeRenameDialog } from "./renameDialog.js";

const value = ref(store.sessionName || "");
const inputEl = ref(null);
const busy = ref(false);

onMounted(() => {
  nextTick(() => inputEl.value?.focus());
});

async function confirm() {
  const next = value.value.trim();
  if (!next || busy.value) {
    closeRenameDialog();
    return;
  }
  busy.value = true;
  try {
    await setSessionName(next);
    // The sidebar's session list is only otherwise re-fetched on
    // project/session switch or after a turn settles — refresh right away
    // so a rename shows up immediately instead of waiting for either.
    refreshCurrentSessions();
  } finally {
    busy.value = false;
  }
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

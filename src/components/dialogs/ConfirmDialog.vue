<!--
  Small modal replacing the browser's native confirm()/alert(), backed by
  stores/confirm.js (confirmStore is a singleton — only one dialog is ever
  open at a time). Backdrop mousedown and Escape cancel; the confirm button
  is focused on mount so a bare Enter confirms immediately. Alert mode
  (confirmStore.kind === "alert") hides the cancel button.
-->
<script setup>
import { nextTick, onMounted, ref } from "vue";
import { confirmStore, resolveConfirm } from "../../stores/confirm.js";

const confirmBtn = ref(null);

onMounted(() => {
  nextTick(() => confirmBtn.value?.focus());
});

function onBackdrop(e) {
  if (e.target === e.currentTarget) resolveConfirm(false);
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop" @keydown.escape="resolveConfirm(false)">
    <div class="connect-panel confirm-panel">
      <div class="connect-head">
        <span>{{ confirmStore.title }}</span>
        <button class="connect-close" title="Close" @click="resolveConfirm(false)">✕</button>
      </div>
      <p class="confirm-message">{{ confirmStore.message }}</p>
      <div class="connect-actions">
        <button
          ref="confirmBtn"
          type="button"
          :class="{ 'confirm-danger': confirmStore.danger }"
          @click="resolveConfirm(true)"
        >
          {{ confirmStore.confirmLabel }}
        </button>
        <button
          v-if="confirmStore.kind !== 'alert'"
          type="button"
          class="connect-secondary"
          @click="resolveConfirm(false)"
        >
          {{ confirmStore.cancelLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

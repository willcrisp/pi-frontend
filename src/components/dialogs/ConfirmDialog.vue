<!--
  Small modal replacing the browser's native confirm()/alert(), backed by
  stores/confirm.js (confirmStore is a singleton — only one dialog is ever
  open at a time). Backdrop mousedown and Escape cancel; the confirm button
  is focused on mount so a bare Enter confirms immediately. Alert mode
  (confirmStore.kind === "alert") hides the cancel button.

  Escape comes from useDialogEscape, on `window`. It used to be
  `@keydown.escape` on the backdrop <div>, which is not focusable — it happened
  to work only because the confirm button below autofocuses, and stopped working
  as soon as focus moved off the panel.
-->
<script setup>
import { nextTick, onMounted, ref } from "vue";
import { confirmStore, resolveConfirm } from "../../stores/confirm.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const confirmBtn = ref(null);

const { onBackdrop } = useDialogEscape(() => resolveConfirm(false));

onMounted(() => {
  nextTick(() => confirmBtn.value?.focus());
});
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
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

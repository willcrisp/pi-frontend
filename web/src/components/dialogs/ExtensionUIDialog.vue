<script setup>
// Modal for pi's blocking extension UI dialogs (ctx.ui.select/confirm/input/
// editor forwarded over RPC as extension_ui_request — see docs/rpc.md).
// The agent is blocked until each request is answered, so this renders the
// oldest pending request and works through the queue. Follows the
// ConnectDialog pattern and reuses its connect-* styles.
import { computed, ref, watch } from "vue";
import { respondExtensionUI, store } from "../../stores/pi.js";

const current = computed(() => store.uiRequests[0] || null);
const value = ref("");

// Prefill for editor dialogs; reset per request.
watch(
  current,
  (req) => {
    value.value = req?.method === "editor" ? req.prefill || "" : "";
  },
  { immediate: true }
);

function submitValue() {
  respondExtensionUI(current.value.id, { value: value.value });
}

function confirm(confirmed) {
  respondExtensionUI(current.value.id, { confirmed });
}

function cancel() {
  respondExtensionUI(current.value.id, { cancelled: true });
}
</script>

<template>
  <div v-if="current" class="connect-backdrop">
    <div class="connect-panel">
      <div class="connect-head">
        <span>{{ current.title || "Extension request" }}</span>
        <button class="connect-close" title="Dismiss (cancels the dialog)" @click="cancel">✕</button>
      </div>

      <p v-if="current.message" class="ui-dialog-message">{{ current.message }}</p>

      <template v-if="current.method === 'select'">
        <button
          v-for="opt in current.options"
          :key="opt"
          type="button"
          class="connect-option"
          @click="respondExtensionUI(current.id, { value: opt })"
        >
          {{ opt }}
        </button>
      </template>

      <div v-else-if="current.method === 'confirm'" class="connect-actions">
        <button type="button" @click="confirm(true)">Yes</button>
        <button type="button" class="connect-secondary" @click="confirm(false)">No</button>
      </div>

      <form
        v-else-if="current.method === 'input'"
        class="connect-prompt"
        @submit.prevent="submitValue"
      >
        <input v-model="value" :placeholder="current.placeholder || ''" autofocus />
        <div class="connect-actions">
          <button type="submit">Submit</button>
          <button type="button" class="connect-secondary" @click="cancel">Cancel</button>
        </div>
      </form>

      <form
        v-else-if="current.method === 'editor'"
        class="connect-prompt"
        @submit.prevent="submitValue"
      >
        <textarea v-model="value" rows="10" class="ui-dialog-editor" autofocus></textarea>
        <div class="connect-actions">
          <button type="submit">Submit</button>
          <button type="button" class="connect-secondary" @click="cancel">Cancel</button>
        </div>
      </form>

      <p v-if="store.uiRequests.length > 1" class="connect-hint">
        {{ store.uiRequests.length - 1 }} more pending
      </p>
    </div>
  </div>
</template>

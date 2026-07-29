<!--
  The chip under an assistant message whose text is a filed handover document
  (stores/handover.js). It carries the handover's 8-character id, which is the
  handle for the thing — short enough to sit inline and to read out loud.

  Clicking opens HandoverDialog, not a new chat: the point of the dialog is the
  chance to add instructions before the next session is kicked off.
-->
<script setup>
import { openHandover } from "../../stores/handover.js";

const props = defineProps({
  record: { type: Object, required: true },
});

function when() {
  if (!props.record.createdAt) return "";
  return new Date(props.record.createdAt).toLocaleString();
}
</script>

<template>
  <button
    type="button"
    class="handover-chip"
    :title="`Handover ${record.id}${when() ? ` — written ${when()}` : ''}\nClick to start a new chat from it`"
    @click="openHandover(record.id)"
  >
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 8h9M8 4.5 11.5 8 8 11.5M13.5 3v10"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span class="handover-chip-label">handover</span>
    <code class="handover-chip-id">{{ record.id }}</code>
  </button>
</template>

<style scoped>
.handover-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-raised);
  color: var(--dim);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}

.handover-chip:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.handover-chip svg {
  flex: none;
}

.handover-chip-label {
  letter-spacing: 0.02em;
}

.handover-chip-id {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--fg);
  letter-spacing: 0.04em;
}

.handover-chip:hover .handover-chip-id {
  color: var(--accent);
}
</style>

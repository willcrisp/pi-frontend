<!--
  Steer button: sends what's in the composer into a run that is ALREADY GOING,
  for the agent to read at its next turn. Lives inline with the send arrow in
  the composer actions, and only while a run is streaming — with nothing running
  the send arrow is the button you want.

  Same pill shape as the git branch button. It acts on one click: there is no
  mode menu, because the delivery mode that matters here is "steer" (see
  DELIVERY note in opencode.js — "queue" is the same route with the run's end as
  the hand-off point instead of its next turn).

  An admitted prompt is not in the transcript until the server promotes it, so
  the count on the pill is the only sign of one waiting.
-->
<script setup>
import { computed } from "vue";
import { opencodeStore as store, pendingSteersFor } from "../../stores/opencode.js";

defineProps({
  disabled: { type: Boolean, default: false },
});
defineEmits(["steer"]);

const pending = computed(() => pendingSteersFor(store.activeSessionId));

// Nothing on screen shows a steer until the agent takes it, so the ones still
// waiting are named here rather than only counted.
const title = computed(() => {
  if (!pending.value.length) return "Steer: the agent reads this at its next turn (Enter)";
  const waiting = pending.value.map((s) => `· ${s.text}`).join("\n");
  return `Waiting to be read:\n${waiting}\n\nSend another`;
});
</script>

<template>
  <button
    type="button"
    class="steer-trigger"
    :class="{ waiting: pending.length > 0 }"
    :disabled="disabled"
    :title="title"
    @click="$emit('steer')"
  >
    <svg class="steer-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.3" />
      <circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.3" />
      <path
        d="M8 1.8v4.5M2.6 11.1l3.9-2.25M13.4 11.1 9.5 8.85"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
    <span class="steer-label">steer{{ pending.length ? ` · ${pending.length}` : "" }}</span>
  </button>
</template>

<style scoped>
/* Same pill as the git branch button (.branch-trigger in style.css), sized to
   sit on the composer's 26px icon-button row. */
.steer-trigger {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  flex-shrink: 0;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.4;
}

.steer-trigger:hover:not(:disabled) {
  color: var(--fg);
  border-color: #2c3540;
}

.steer-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.steer-trigger.waiting {
  color: var(--accent);
  border-color: var(--accent);
}

.steer-icon {
  flex-shrink: 0;
}

.steer-label {
  white-space: nowrap;
}
</style>

<!--
  Steer button: sends what's in the composer into a run that is ALREADY GOING,
  for the agent to read at its next turn. An icon button on the composer's
  action row, sitting with the paperclip and the stop square, and shown only
  while a run is streaming — with nothing running the send arrow is the button
  you want.

  One click, no menu: the delivery mode that matters here is "steer" (see the
  delivery note in opencode.js — "queue" is the same route with the run's end as
  the hand-off point instead of its next turn).

  An admitted prompt is not in the transcript until the server promotes it, so
  the tooltip is where anything still waiting gets named, and the icon goes
  accent while it waits.
-->
<script setup>
import { computed } from "vue";
import { opencodeStore as store, pendingSteersFor } from "../../stores/opencode.js";

defineProps({
  disabled: { type: Boolean, default: false },
});
defineEmits(["steer"]);

const pending = computed(() => pendingSteersFor(store.activeSessionId));

const title = computed(() => {
  const hint = "Steer — the agent reads this at its next turn (Enter)";
  if (!pending.value.length) return hint;
  return `${hint}\n\nWaiting to be read:\n${pending.value.map((s) => `· ${s.text}`).join("\n")}`;
});
</script>

<template>
  <button
    type="button"
    class="composer-icon-btn steer"
    :class="{ waiting: pending.length > 0 }"
    :disabled="disabled"
    :title="title"
    @click="$emit('steer')"
  >
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
      <circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.2" />
      <path
        d="M8 1.8v4.5M2.6 11.1l3.9-2.25M13.4 11.1 9.5 8.85"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
    </svg>
  </button>
</template>

<style scoped>
/* Sizing and shape come from .composer-icon-btn in style.css; this is the same
   dim → bright treatment the paperclip has. */
.steer {
  color: var(--dim);
}

.steer:hover:not(:disabled) {
  color: var(--fg);
  background: var(--bg);
}

.steer:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Something is sent but not yet read. */
.steer.waiting {
  color: var(--accent);
}
</style>

<!--
  A reasoning part — the model's thinking, rendered as the dim italic quote the
  transcript has always shown, but collapsed to its latest line and expandable.

  Why collapsed: while a run is live this is the only window into whether the
  agent is on track, and it is also the longest thing in the turn. Left fully
  expanded it buries the tool calls and the answer under a wall of italics; left
  hidden you can't tell a good chain of thought from a lost one. So the collapsed
  state shows the TAIL while it streams (the thought it is having now, which is
  the part worth reading) and the opening line once it's finished, and one click
  on the quote opens the whole thing.

  Expanded, the body is capped and scrolls inside itself rather than pushing the
  transcript around, and while the run is live it follows the newest text.

  The root keeps the `thinking` class: `styles/messages.css` owns the quote's
  colour, italics and the user's thinking-size preference (--thinking-font-scale),
  and this component's own chrome is scoped below.
-->
<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { renderMarkdown } from "../../lib/markdown.js";

const props = defineProps({
  text: { type: String, default: "" },
  // The part is still streaming: preview the tail rather than the opening, and
  // follow it while open.
  live: { type: Boolean, default: false },
});

const open = ref(false);
const bodyEl = ref(null);

const PREVIEW_CHARS = 220;

// One flowing line: reasoning arrives with hard wraps and blank lines, which a
// two-line clamp would spend on nothing.
const flat = computed(() => props.text.replace(/\s+/g, " ").trim());

const preview = computed(() => {
  const t = flat.value;
  if (t.length <= PREVIEW_CHARS) return t;
  return props.live ? `…${t.slice(-PREVIEW_CHARS)}` : `${t.slice(0, PREVIEW_CHARS)}…`;
});

const words = computed(() => (flat.value ? flat.value.split(" ").length : 0));

const rendered = computed(() => renderMarkdown(props.text || ""));

const label = computed(() => {
  if (props.live) return "thinking";
  return words.value ? `thought · ${words.value} words` : "thought";
});

// Follow the newest thinking while it streams, so an open block behaves like the
// tail it replaced instead of stranding you at the top of it.
watch(
  () => props.text,
  () => {
    if (!open.value || !props.live) return;
    nextTick(() => {
      const el = bodyEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
);
</script>

<template>
  <div class="thinking thinking-block" :class="{ open, live }">
    <button
      type="button"
      class="thinking-head"
      :title="open ? 'Hide the model’s thinking' : 'Show the model’s thinking'"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="thinking-caret" aria-hidden="true">▸</span>
      <span class="thinking-label">{{ label }}</span>
      <span v-if="!open" class="thinking-peek">{{ preview }}</span>
    </button>
    <div v-if="open" ref="bodyEl" class="thinking-body markdown" v-html="rendered"></div>
  </div>
</template>

<style scoped>
/* One rule on the wrapper, so the quote's bar runs the height of the block
   whether it is showing two lines or forty. */
.thinking-block {
  margin-bottom: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--border);
  transition: border-color 0.12s;
}

.thinking-block:hover {
  border-left-color: var(--accent);
}

/* The whole quote is the control — "click the thinking to expand it" — so the
   button carries no button chrome. */
.thinking-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.thinking-block:hover .thinking-label {
  color: var(--fg);
}

.thinking-caret {
  flex: none;
  font-size: 9px;
  line-height: 1.7;
  transition: transform 0.12s ease;
}

.open .thinking-caret {
  transform: rotate(90deg);
}

.thinking-label {
  flex: none;
  font-style: normal;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  opacity: 0.8;
}

/* Only the pulse says "still going" — a spinner next to streaming text is noise. */
.live .thinking-label {
  animation: thinking-pulse 1.6s ease-in-out infinite;
}

@keyframes thinking-pulse {
  0%, 100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

/* Two lines, then ellipsis: enough to see the shape of the current thought
   without the block growing as it streams. */
.thinking-peek {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-width: 0;
}

/* Capped and scrolling inside itself: a long chain of thought shouldn't push the
   answer, the tool calls and the composer off the screen just because it's open. */
.thinking-body {
  max-height: 40vh;
  overflow-y: auto;
  margin-top: 2px;
}
</style>

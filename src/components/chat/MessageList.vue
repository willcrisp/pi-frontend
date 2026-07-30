<!--
  MessageList component: renders messages from opencodeStore, mounts the prompt
  rail and the find bar, and keeps the view pinned to the newest output.

  Auto-scroll follows the stream only while the user is already at the bottom.
  Scrolling up is treated as "I am reading something" and is left alone until
  the user comes back down — otherwise every token of a streaming reply yanked
  the transcript out from under them. Sending a prompt always jumps back down,
  since that is the user asking for the newest output.
-->
<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import { randomThinkingPhrase } from "../../lib/thinkingPhrases.js";
import MessageView from "./MessageView.vue";
import MessageRail from "./MessageRail.vue";
import FindBar from "./FindBar.vue";

const mainEl = ref(null);
const messagesEl = ref(null);

// How close to the bottom still counts as following the stream. Same threshold
// MessageRail uses to decide whether to offer its jump-to-latest button, so the
// two never disagree about what "at the bottom" means.
const BOTTOM_THRESHOLD = 120;

// Whether auto-scroll is currently following new output.
const pinned = ref(true);

function atBottom() {
  const el = mainEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
}

function onScroll() {
  pinned.value = atBottom();
}

function scrollToBottom() {
  nextTick(() => {
    const el = mainEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// Follow new output only while pinned.
function followStream() {
  if (pinned.value) scrollToBottom();
}

watch(
  () => store.messages.length,
  () => {
    // The user's own prompt always wins over where they had scrolled to: they
    // just asked for output, so take them to it.
    if (store.messages.at(-1)?.role === "user") {
      pinned.value = true;
      scrollToBottom();
      return;
    }
    followStream();
  }
);

watch(() => store.messages.at(-1)?.text, followStream);

// Streamed text moves `text`, but a turn that opens with a long stretch of
// thinking (or a tool call) moves neither it nor `messages.length` — so follow
// the newest part's own growth as well, or the view sits still while the agent
// is visibly working.
watch(() => store.messages.at(-1)?.parts?.at(-1)?.text, followStream);

// A different chat starts at its own bottom, whatever the scroll position in
// the one being left.
watch(
  () => store.activeSessionId,
  () => {
    pinned.value = true;
    scrollToBottom();
  }
);

// The waiting indicator's label: a fresh silly phrase each time a run starts,
// swapped every few seconds so a long wait doesn't look frozen.
const THINKING_ROTATE_MS = 4000;
const thinkingPhrase = ref(randomThinkingPhrase());
let thinkingTimer = null;

function stopThinkingRotation() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

watch(
  () => store.isStreaming,
  (streaming) => {
    stopThinkingRotation();
    if (!streaming) return;
    thinkingPhrase.value = randomThinkingPhrase(thinkingPhrase.value);
    thinkingTimer = setInterval(() => {
      thinkingPhrase.value = randomThinkingPhrase(thinkingPhrase.value);
    }, THINKING_ROTATE_MS);
  }
);

onMounted(() => {
  mainEl.value?.addEventListener("scroll", onScroll, { passive: true });
  scrollToBottom();
});

onBeforeUnmount(() => {
  mainEl.value?.removeEventListener("scroll", onScroll);
  stopThinkingRotation();
});
</script>

<template>
  <div class="message-area">
    <main ref="mainEl">
      <div ref="messagesEl" class="messages">
        <TransitionGroup name="msg-fade">
          <MessageView
            v-for="(msg, i) in store.messages"
            :id="`msg-${i}`"
            :key="msg.id || i"
            :message="msg"
          />
          <div v-if="store.isStreaming && (!store.messages.length || store.messages.at(-1)?.role === 'user')" key="thinking" class="thinking-indicator">
            <span class="thinking-dots"><span></span><span></span><span></span></span>
            {{ thinkingPhrase }}…
          </div>
        </TransitionGroup>
      </div>
    </main>
    <MessageRail :scroller="mainEl" />
    <!-- Absolutely positioned against .message-area, so it floats over the
         column rather than pushing it down (see styles/find-bar.css). -->
    <FindBar :container="messagesEl" />
  </div>
</template>

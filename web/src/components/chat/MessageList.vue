<!--
  Scrollable message column: renders user/assistant messages from store.messages
  (pi.js) via MessageView.vue, auto-scrolling to follow the stream unless the
  user has scrolled up more than ~120px. New messages fade/rise in via a
  TransitionGroup, and following the stream glides smoothly instead of
  snapping, so growth reads as motion rather than a jump-scare; switching to a
  whole different chat still snaps to the bottom instantly (see the
  `store.messages` identity watch below). A "thinking" indicator fills the gap
  between sending a prompt and the first token/tool call arriving — otherwise
  dead silence a cold-started pi process can stretch to several seconds, with
  nothing on screen to say it isn't just hung (see `awaitingFirstToken` /
  `coldStart` in pi.js). Also mounts MessageRail.vue, the floating
  prompt-index gutter, passing it the scroll container, and FindBar.vue, the
  Ctrl/Cmd+F find-in-transcript bar, passing it the `.messages` element to
  search.
-->
<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { store } from "../../stores/pi.js";
import MessageView from "./MessageView.vue";
import MessageRail from "./MessageRail.vue";
import FindBar from "./FindBar.vue";

const mainEl = ref(null);
const messagesEl = ref(null);

// Paired positionally with get_fork_messages (same rule as MessageRail.vue):
// the nth user message's fork point is store.forkMessages[n]. Optimistic
// messages sent this turn have no entry yet and get null.
const visible = computed(() => {
  let nth = 0;
  return store.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      message: m,
      forkEntryId: m.role === "user" ? store.forkMessages[nth++]?.entryId ?? null : null,
    }));
});

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function followIfNearBottom(behavior) {
  const el = mainEl.value;
  if (!el || !isNearBottom(el)) return;
  nextTick(() => el.scrollTo({ top: el.scrollHeight, behavior }));
}

// Switching to a different chat entirely swaps in a brand new `messages`
// array (see the `store` proxy in pi.js) — that's a scene change, not
// growth, so it snaps to the bottom instantly rather than gliding across an
// unrelated transcript.
watch(
  () => store.messages,
  async () => {
    await nextTick();
    mainEl.value?.scrollTo({ top: mainEl.value.scrollHeight, behavior: "instant" });
  }
);

// Follow the stream unless the user has scrolled up: new messages, streamed
// text/thinking/tool-call blocks (all folded into the last message object),
// and growing tool-output text (kept separately in store.toolResults, so it
// needs its own trigger — a long-running command's output would otherwise
// grow the page under the user without the view following it).
watch(
  () => JSON.stringify(store.messages.at(-1) ?? null),
  () => followIfNearBottom("smooth")
);
const toolTextLength = computed(() =>
  Object.values(store.toolResults).reduce((n, r) => n + (r.text?.length || 0), 0)
);
watch(toolTextLength, () => followIfNearBottom("smooth"));

// The indicator's appearance/disappearance changes the page height too.
watch(
  () => store.awaitingFirstToken,
  () => followIfNearBottom("smooth")
);
</script>

<template>
  <div class="message-area">
    <main ref="mainEl">
      <div ref="messagesEl" class="messages">
        <!-- No `tag` on TransitionGroup: it renders no wrapper of its own, so
             .messages above stays the actual flex container (its gap/padding
             would otherwise apply to a wrapper instead of these children). -->
        <TransitionGroup name="msg-fade">
          <MessageView
            v-for="(v, i) in visible"
            :id="`msg-${i}`"
            :key="i"
            :message="v.message"
            :fork-entry-id="v.forkEntryId"
          />
          <div v-if="store.awaitingFirstToken" key="thinking-indicator" class="thinking-indicator">
            <span class="thinking-dots"><span></span><span></span><span></span></span>
            {{ store.coldStart ? "Starting a new agent process…" : "Thinking…" }}
          </div>
        </TransitionGroup>
      </div>
    </main>
    <MessageRail :scroller="mainEl" />
    <FindBar :container="messagesEl" />
  </div>
</template>

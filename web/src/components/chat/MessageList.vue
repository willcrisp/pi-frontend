<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { store } from "../../stores/pi.js";
import MessageView from "./MessageView.vue";
import MessageRail from "./MessageRail.vue";

const mainEl = ref(null);

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

// Follow the stream unless the user has scrolled up.
watch(
  () => JSON.stringify(store.messages.at(-1) ?? null),
  async () => {
    const el = mainEl.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      await nextTick();
      el.scrollTop = el.scrollHeight;
    }
  }
);
</script>

<template>
  <div class="message-area">
    <main ref="mainEl">
      <div class="messages">
        <MessageView
          v-for="(v, i) in visible"
          :id="`msg-${i}`"
          :key="i"
          :message="v.message"
          :fork-entry-id="v.forkEntryId"
        />
      </div>
    </main>
    <MessageRail :scroller="mainEl" />
  </div>
</template>

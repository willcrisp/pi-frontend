<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { store } from "./pi.js";
import MessageView from "./MessageView.vue";
import MessageRail from "./MessageRail.vue";

const mainEl = ref(null);

const visible = computed(() =>
  store.messages.filter((m) => m.role === "user" || m.role === "assistant")
);

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
          v-for="(m, i) in visible"
          :id="`msg-${i}`"
          :key="i"
          :message="m"
        />
      </div>
    </main>
    <MessageRail :scroller="mainEl" />
  </div>
</template>

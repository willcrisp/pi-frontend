<!--
  MessageList component: renders messages from opencodeStore, handles auto-scroll, and mounts MessageRail.
-->
<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import MessageView from "./MessageView.vue";
import MessageRail from "./MessageRail.vue";

const mainEl = ref(null);

function scrollToBottom() {
  nextTick(() => {
    if (mainEl.value) {
      mainEl.value.scrollTop = mainEl.value.scrollHeight;
    }
  });
}

watch(
  () => store.messages.length,
  () => scrollToBottom()
);

watch(
  () => store.messages.at(-1)?.text,
  () => scrollToBottom()
);
</script>

<template>
  <div class="message-area">
    <main ref="mainEl">
      <div class="messages">
        <TransitionGroup name="msg-fade">
          <MessageView
            v-for="(msg, i) in store.messages"
            :id="`msg-${i}`"
            :key="msg.id || i"
            :message="msg"
          />
          <div v-if="store.isStreaming && (!store.messages.length || store.messages.at(-1)?.role === 'user')" key="thinking" class="thinking-indicator">
            <span class="thinking-dots"><span></span><span></span><span></span></span>
            OpenCode is thinking…
          </div>
        </TransitionGroup>
      </div>
    </main>
    <MessageRail :scroller="mainEl" />
  </div>
</template>

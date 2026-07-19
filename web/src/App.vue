<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { abort, sendPrompt, store } from "./pi.js";
import MessageView from "./MessageView.vue";

const input = ref("");
const textareaEl = ref(null);
const mainEl = ref(null);

const visible = computed(() =>
  store.messages.filter((m) => m.role === "user" || m.role === "assistant")
);

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);

function submit() {
  const text = input.value.trim();
  if (!text) return;
  sendPrompt(text);
  input.value = "";
  nextTick(autosize);
}

function onKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function autosize() {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

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
  <header>
    <span
      class="dot"
      :class="{ connected: store.connected, streaming: store.streaming }"
    ></span>
    <span class="wordmark">pi</span>
    <span>{{ modelLabel }}</span>
    <span v-if="store.sessionName">· {{ store.sessionName }}</span>
  </header>

  <main ref="mainEl">
    <div class="messages">
      <MessageView v-for="(m, i) in visible" :key="i" :message="m" />
    </div>
  </main>

  <footer>
    <div class="composer">
      <textarea
        ref="textareaEl"
        v-model="input"
        rows="1"
        placeholder="Message pi…"
        @keydown="onKeydown"
        @input="autosize"
      ></textarea>
      <button v-if="store.streaming" class="stop" @click="abort">stop</button>
      <button v-else @click="submit">send</button>
    </div>
  </footer>
</template>

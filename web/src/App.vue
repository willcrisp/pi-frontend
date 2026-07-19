<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  THINKING_LEVELS,
  abort,
  sendPrompt,
  setModel,
  setThinkingLevel,
  store,
} from "./pi.js";
import MessageView from "./MessageView.vue";
import UsagePopover from "./UsagePopover.vue";

const input = ref("");
const textareaEl = ref(null);
const mainEl = ref(null);

const visible = computed(() =>
  store.messages.filter((m) => m.role === "user" || m.role === "assistant")
);

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);

const modelKey = computed(() =>
  store.model ? `${store.model.provider}::${store.model.id}` : ""
);

const thinkingDisabled = computed(() => !store.model?.reasoning);

// Desaturated pastel gradient, cool blue (low effort) to warm red (max effort),
// tuned light enough to read on the dark theme.
const THINKING_COLORS = {
  off: "hsl(215 38% 72%)",
  minimal: "hsl(190 36% 68%)",
  low: "hsl(160 34% 65%)",
  medium: "hsl(110 32% 64%)",
  high: "hsl(70 38% 64%)",
  xhigh: "hsl(35 42% 66%)",
  max: "hsl(5 46% 70%)",
};

function thinkingColor(level) {
  return THINKING_COLORS[level] || "inherit";
}

function onModelChange(e) {
  const key = e.target.value;
  const model = store.availableModels.find(
    (m) => `${m.provider}::${m.id}` === key
  );
  if (model) setModel(model);
}

function onThinkingChange(e) {
  setThinkingLevel(e.target.value);
}

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
    <UsagePopover class="header-usage" />
  </header>

  <main ref="mainEl">
    <div class="messages">
      <MessageView v-for="(m, i) in visible" :key="i" :message="m" />
    </div>
  </main>

  <footer>
    <div class="composer">
      <div class="composer-field">
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          placeholder="Message pi…"
          @keydown="onKeydown"
          @input="autosize"
        ></textarea>
        <button
          v-if="store.streaming"
          class="icon-btn stop"
          aria-label="Stop"
          title="Stop"
          @click="abort"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          v-else
          class="icon-btn send"
          aria-label="Send"
          title="Send"
          :disabled="!input.trim()"
          @click="submit"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M14.7 1.3 7.3 8.7M14.7 1.3 10 14.7 7.3 8.7 1.3 6 14.7 1.3Z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
    <div class="controls">
      <select
        class="model-select"
        :value="modelKey"
        title="Model"
        @change="onModelChange"
      >
        <option v-if="!store.availableModels.length" :value="modelKey">
          {{ modelLabel }}
        </option>
        <option
          v-for="m in store.availableModels"
          :key="`${m.provider}::${m.id}`"
          :value="`${m.provider}::${m.id}`"
        >
          {{ m.name || m.id }}
        </option>
      </select>
      <span
        class="level-dot"
        :style="{ background: thinkingDisabled ? 'var(--dim)' : thinkingColor(store.thinkingLevel) }"
      ></span>
      <select
        class="thinking-select"
        :value="store.thinkingLevel || ''"
        title="Reasoning effort"
        :disabled="thinkingDisabled"
        :style="{ color: thinkingDisabled ? '' : thinkingColor(store.thinkingLevel) }"
        @change="onThinkingChange"
      >
        <option
          v-for="level in THINKING_LEVELS"
          :key="level"
          :value="level"
          :style="{ color: thinkingColor(level) }"
        >
          {{ level }}
        </option>
      </select>
    </div>
  </footer>
</template>

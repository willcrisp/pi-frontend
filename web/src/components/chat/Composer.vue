<!--
  Composer component for OpenCode V2: handles text input, model/agent select, D20 die fidget toy, send prompt & abort actions.
-->
<script setup>
import { computed, nextTick, ref } from "vue";
import {
  opencodeStore as store,
  sendPrompt,
  abortSession,
  setModel,
  setAgent,
} from "../../stores/opencode.js";
import D20Die from "./D20Die.vue";

const input = ref("");
const textareaEl = ref(null);

const sending = computed(() => store.isStreaming);

function submit() {
  const text = input.value.trim();
  if (!text || store.isStreaming) return;

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

const selectedModelKey = computed(() =>
  store.selectedModel ? `${store.selectedModel.providerID}:${store.selectedModel.modelID}` : ""
);

function onModelChange(e) {
  const value = e.target.value;
  if (!value) return;
  const sep = value.indexOf(":");
  setModel({ providerID: value.slice(0, sep), modelID: value.slice(sep + 1) });
}

function onAgentChange(e) {
  setAgent(e.target.value);
}
</script>

<template>
  <footer>
    <div class="composer">
      <D20Die />
      <div class="composer-field">
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          placeholder="Ask OpenCode V2..."
          title="Enter to send, Shift+Enter for newline"
          @keydown="onKeydown"
          @input="autosize"
        ></textarea>

        <div class="composer-actions">
          <button
            v-if="store.isStreaming"
            class="composer-icon-btn stop"
            title="Stop"
            @click="abortSession"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            v-else
            class="composer-icon-btn send"
            :disabled="!input.trim() || !store.activeSessionId"
            title="Send prompt"
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
    </div>

    <div class="controls">
      <select
        v-if="store.availableModels.length"
        class="model-select"
        :value="selectedModelKey"
        title="Model"
        @change="onModelChange"
      >
        <option
          v-for="m in store.availableModels"
          :key="`${m.providerID}:${m.modelID}`"
          :value="`${m.providerID}:${m.modelID}`"
        >
          {{ m.label }}
        </option>
      </select>

      <select
        v-if="store.availableAgents.length"
        class="thinking-select"
        :value="store.selectedAgent"
        title="Agent"
        @change="onAgentChange"
      >
        <option v-for="a in store.availableAgents" :key="a.name" :value="a.name" :title="a.description">
          {{ a.name }}
        </option>
      </select>
    </div>
  </footer>
</template>

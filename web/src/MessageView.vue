<script setup>
import { computed } from "vue";
import { store } from "./pi.js";

const props = defineProps({ message: { type: Object, required: true } });

// User content may be a plain string; assistant content is always blocks.
const blocks = computed(() => {
  const c = props.message.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
});

function argsSummary(args) {
  if (!args) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function toolResult(id) {
  return store.toolResults[id];
}
</script>

<template>
  <div :class="message.role === 'user' ? 'msg-user' : 'msg-assistant'">
    <template v-for="(block, i) in blocks" :key="i">
      <span v-if="block.type === 'text'">{{ block.text }}</span>

      <details v-else-if="block.type === 'thinking'" class="thinking">
        <summary>thinking</summary>
        {{ block.thinking }}
      </details>

      <details
        v-else-if="block.type === 'toolCall'"
        class="tool"
        :class="{ error: toolResult(block.id)?.isError }"
        :open="toolResult(block.id)?.running"
      >
        <summary>
          <span class="tool-name">{{ block.name }}</span>
          {{ argsSummary(block.arguments) }}
          <span v-if="toolResult(block.id)?.running" class="running">⋯</span>
        </summary>
        <pre v-if="toolResult(block.id)?.text">{{ toolResult(block.id).text }}</pre>
      </details>
    </template>
  </div>
</template>

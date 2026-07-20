<script setup>
import { computed } from "vue";
import { store, subagentDetails } from "./pi.js";
import { renderMarkdown } from "./markdown.js";
import SubagentView from "./SubagentView.vue";

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

function isSubagent(block) {
  return block.name === "subagent" || !!subagentDetails(toolResult(block.id));
}
</script>

<template>
  <div :class="message.role === 'user' ? 'msg-user' : 'msg-assistant'">
    <template v-for="(block, i) in blocks" :key="i">
      <div
        v-if="block.type === 'text' && message.role !== 'user'"
        class="markdown"
        v-html="renderMarkdown(block.text)"
      ></div>
      <span v-else-if="block.type === 'text'">{{ block.text }}</span>

      <img
        v-else-if="block.type === 'image'"
        class="msg-image"
        :src="`data:${block.mimeType};base64,${block.data}`"
        alt=""
      />

      <details v-else-if="block.type === 'thinking'" class="thinking">
        <summary title="Click to expand/collapse">thinking</summary>
        {{ block.thinking }}
      </details>

      <SubagentView
        v-else-if="block.type === 'toolCall' && isSubagent(block)"
        :tool-call-id="block.id"
        :args="block.arguments"
      />

      <details
        v-else-if="block.type === 'toolCall'"
        class="tool"
        :class="{ error: toolResult(block.id)?.isError }"
        :open="toolResult(block.id)?.running"
      >
        <summary title="Click to expand/collapse">
          <span class="tool-name" :title="block.name">{{ block.name }}</span>
          {{ argsSummary(block.arguments) }}
          <span v-if="toolResult(block.id)?.running" class="running" title="Running">⋯</span>
        </summary>
        <pre v-if="toolResult(block.id)?.text">{{ toolResult(block.id).text }}</pre>
      </details>
    </template>
  </div>
</template>

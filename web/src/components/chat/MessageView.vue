<!--
  MessageView component: renders a single message (user or assistant) from OpenCode V2.
  Iterates message.parts (near-verbatim OpenCode API parts) and renders each by type:
  text, reasoning, tool (with pending/running/completed/error state), and file. step-start/
  step-finish parts are structural markers and render nothing. Falls back to the message's
  flattened `text` field when `parts` is empty (e.g. legacy/optimistic messages).
-->
<script setup>
import { computed } from "vue";
import { renderMarkdown } from "../../lib/markdown.js";

const props = defineProps({
  message: { type: Object, required: true },
});

const isUser = computed(() => props.message.role === "user");

const hasParts = computed(
  () => Array.isArray(props.message.parts) && props.message.parts.length > 0
);

const renderedText = computed(() => renderMarkdown(props.message.text || ""));

function renderPart(text) {
  return renderMarkdown(text || "");
}

function truncate(text) {
  if (!text) return "";
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}
</script>

<template>
  <div class="msg" :class="isUser ? 'msg-user' : 'msg-assistant'">
    <template v-if="hasParts">
      <template v-for="part in message.parts" :key="part.id">
        <!-- text -->
        <div v-if="part.type === 'text' && isUser" class="user-text">{{ part.text }}</div>
        <div
          v-else-if="part.type === 'text'"
          class="markdown"
          v-html="renderPart(part.text)"
        ></div>

        <!-- reasoning -->
        <div v-else-if="part.type === 'reasoning'" class="thinking markdown" v-html="renderPart(part.text)"></div>

        <!-- tool -->
        <details v-else-if="part.type === 'tool'" class="tool" :class="{ error: part.state?.status === 'error' }">
          <summary title="Click to expand/collapse">
            <span class="tool-name" :title="part.tool">{{ part.tool }}</span>
            <span v-if="part.state?.status === 'running' || part.state?.status === 'pending'" class="running" title="Running">⋯</span>
          </summary>
          <pre v-if="part.state?.status === 'completed'">{{ truncate(part.state.output) }}</pre>
          <pre v-else-if="part.state?.status === 'error'">{{ truncate(part.state.error) }}</pre>
        </details>

        <!-- file -->
        <component
          :is="part.url ? 'a' : 'span'"
          v-else-if="part.type === 'file'"
          class="msg-file"
          :href="part.url"
          :target="part.url ? '_blank' : null"
          rel="noopener noreferrer"
        >
          {{ part.filename || part.mime }}
        </component>

        <!-- step-start / step-finish: no visual representation -->
      </template>
    </template>

    <template v-else>
      <div v-if="isUser" class="user-text">{{ message.text }}</div>
      <div v-else class="markdown" v-html="renderedText"></div>
    </template>
  </div>
</template>

<style scoped>
.msg-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--dim);
  font-family: var(--mono);
  font-size: 11.5px;
  text-decoration: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a.msg-file:hover {
  color: var(--fg);
  border-color: #2c3540;
}
</style>

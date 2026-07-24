<!--
  MessageView component: renders a single message (user or assistant) from OpenCode V2.
-->
<script setup>
import { computed } from "vue";
import { renderMarkdown } from "../../lib/markdown.js";

const props = defineProps({
  message: { type: Object, required: true },
});

const isUser = computed(() => props.message.role === "user");

const renderedText = computed(() => {
  return renderMarkdown(props.message.text || "");
});
</script>

<template>
  <div class="msg" :class="isUser ? 'msg-user' : 'msg-assistant'">
    <div v-if="isUser" class="user-text">
      {{ message.text }}
    </div>

    <div v-else class="markdown" v-html="renderedText"></div>
  </div>
</template>

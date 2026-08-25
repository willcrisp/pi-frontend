<script setup>
// One message. A deliberately reduced version of the desktop MessageView:
// user text, assistant markdown, a one-line summary per tool call, and thinking
// collapsed to a single tappable line.
//
// What is dropped and why: inline diffs (unreadable at 390px — the tool line
// says which file changed, and reviewing a diff is a desk job), sub-agent
// cards, the revert rail, web-search cards, and the find bar. The parts still
// arrive in the store; this just doesn't render them.
import { computed, ref } from "vue";
import { renderMarkdown } from "../../lib/markdown.js";
// renderMarkdown bakes a copy button into every fenced block and expects a
// delegated click handler; without one it renders as a dead grey square. It also
// earns its place here — copying a command off a phone screen is otherwise a
// long-press-and-drag exercise — and its non-secure-context fallback is what
// makes it work at all, since the app is served over plain http from the
// in-app proxy.
import { onMarkdownClick } from "../../lib/codeCopy.js";

const props = defineProps({ message: { type: Object, required: true } });

const isUser = computed(() => props.message.role === "user");
const expanded = ref(new Set());

function toggle(i) {
  const next = new Set(expanded.value);
  next.has(i) ? next.delete(i) : next.add(i);
  expanded.value = next;
}

// A tool call reads as one line: what it did, and whether it is done. `state`
// carries the status on both wire shapes.
function toolLabel(part) {
  const name = (part.tool || "tool").replace(/^[a-z0-9]+_/i, "");
  const input = (part.state && part.state.input) || {};
  const target = input.filePath || input.path || input.command || input.pattern || "";
  return target ? `${name} ${target}` : name;
}

function toolStatus(part) {
  return (part.state && part.state.status) || "";
}

// Reasoning collapses to its first line; the whole thing is one tap away.
// Left expanded it buries the answer, and on a phone it buries it completely.
function firstLine(text) {
  const line = (text || "").trim().split("\n").find((l) => l.trim());
  return line || "Thinking…";
}

function imageUrl(part) {
  return part.url || (part.source && part.source.url) || "";
}

function isImage(part) {
  return part.type === "file" && /^image\//.test(part.mime || "");
}
</script>

<template>
  <div class="msg" :class="{ user: isUser }">
    <div v-if="isUser" class="bubble">{{ message.text }}</div>

    <template v-else>
      <template v-for="(part, i) in message.parts" :key="i">
        <div
          v-if="part.type === 'text' && !part.synthetic"
          class="md"
          v-html="renderMarkdown(part.text || '')"
          @click="onMarkdownClick"
        />

        <button
          v-else-if="part.type === 'reasoning'"
          class="thinking"
          :class="{ open: expanded.has(i) }"
          @click="toggle(i)"
        >
          <span class="think-icon">✳</span>
          <span class="think-text">{{
            expanded.has(i) ? part.text : firstLine(part.text)
          }}</span>
        </button>

        <img v-else-if="isImage(part)" class="img" :src="imageUrl(part)" alt="" />

        <div v-else-if="part.type === 'tool'" class="tool" :class="toolStatus(part)">
          <span class="tool-dot" />
          <span class="tool-label">{{ toolLabel(part) }}</span>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 16px;
}

.msg.user {
  align-items: flex-end;
}

.bubble {
  max-width: 84%;
  padding: 10px 14px;
  border-radius: 16px 16px 4px 16px;
  background: var(--accent);
  color: var(--accent-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.md {
  font-size: 15px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

/* Code is the one thing that can't wrap, so it gets its own scroller rather
   than pushing the whole transcript sideways. */
.md :deep(pre) {
  position: relative;
  overflow-x: auto;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg-raised);
  font-size: 13px;
}

/* The copy button sits over the block's top-right. `sticky` rather than
   `absolute` so it stays put while the code scrolls sideways under it. */
.md :deep(.code-copy) {
  position: sticky;
  /* anchors the extended hit area below */
  isolation: isolate;
  float: right;
  top: 0;
  width: 30px;
  height: 30px;
  margin: -4px -4px 0 0;
  border: 0;
  border-radius: 8px;
  background: var(--line);
  color: var(--fg-dim);
}

.md :deep(.code-copy)::after {
  content: "⧉";
  font-size: 14px;
}

/* The button itself has to stay small to fit the code block's corner, so the
   touch target is extended past its box instead — a finger lands on 44px even
   though only 30px is painted. */
.md :deep(.code-copy)::before {
  content: "";
  position: absolute;
  inset: -7px;
}

.md :deep(.code-copy.copied)::after {
  content: "✓";
  color: var(--ok);
}

.md :deep(code) {
  font-size: 13px;
}

.md :deep(p) {
  margin: 0 0 10px;
}

.md :deep(table) {
  display: block;
  overflow-x: auto;
}

.thinking {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-left: 2px solid var(--line);
  background: transparent;
  color: var(--fg-dim);
  font-size: 13px;
  font-style: italic;
  text-align: left;
}

.thinking .think-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking.open .think-text {
  white-space: pre-wrap;
}

.tool {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--fg-dim);
  font-family: var(--mono);
}

.tool-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-dim);
}

.tool.running .tool-dot {
  background: var(--warn-fg);
}

.tool.completed .tool-dot {
  background: var(--ok);
}

.tool.error .tool-dot {
  background: var(--bad);
}

.img {
  max-width: 84%;
  border-radius: 12px;
}
</style>

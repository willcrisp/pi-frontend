<!--
  Renders one message's content blocks (text/image/thinking/toolCall). Text
  renders through markdown.js for assistant messages, plain for user ones.
  Tool calls are looked up live from store.toolResults by id (not embedded in
  the message), and render as one of: SubagentView.vue (sub-agent dispatch,
  detected via subagentDetails()), a collapsed unified diff (edit/write calls,
  detected by argument shape via diff.js), or a generic raw-args <details>
  block. Both collapse by default and rely on native <details> state (no
  reactive :open binding), so a running tool call doesn't force itself open
  and the user's expand/collapse choice just sticks. A hover toolbar offers
  copy-to-clipboard, and — on user messages with a fork
  point, edit-and-resend (forkFrom). Assistant messages starting with a
  handover marker get a "Continue in new chat" action.
-->
<script setup>
import { computed, ref } from "vue";
import {
  continueFromHandover,
  forkFrom,
  handoverFromText,
  isSerenaTool,
  store,
  subagentDetails,
} from "../../stores/pi.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { collapseRows, editDiffInfo, lineDiff } from "../../lib/diff.js";
import SubagentView from "./SubagentView.vue";

const props = defineProps({
  message: { type: Object, required: true },
  // Fork point for a user message (paired positionally with get_fork_messages
  // by MessageList.vue); null while the message is optimistic/unforkable.
  forkEntryId: { type: [String, Number], default: null },
});

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

// --- message-level actions (hover) ---

const messageText = computed(() =>
  blocks.value
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
);

const handover = computed(() =>
  props.message.role === "assistant" ? handoverFromText(messageText.value) : null
);

const copied = ref(false);
let copiedTimer = null;

async function copyMessage() {
  if (!messageText.value) return;
  await navigator.clipboard.writeText(messageText.value);
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}

// Edit & resend = fork at this prompt (forkFrom already loads the prompt's
// text back into the composer for editing).
const forking = ref(false);

async function editResend() {
  if (!props.forkEntryId || forking.value) return;
  forking.value = true;
  try {
    await forkFrom(props.forkEntryId);
  } catch (e) {
    console.warn("fork failed:", e.message);
  } finally {
    forking.value = false;
  }
}

// Copy buttons inside rendered markdown code blocks (injected as static HTML
// by markdown.js, so handled via event delegation rather than Vue bindings).
async function onMarkdownClick(e) {
  const btn = e.target.closest?.(".code-copy");
  if (!btn) return;
  const code = btn.parentElement?.querySelector("code");
  if (!code) return;
  await navigator.clipboard.writeText(code.textContent);
  btn.classList.add("copied");
  setTimeout(() => btn.classList.remove("copied"), 1500);
}

// --- edit/write tool calls rendered as diffs ---

// Keyed by call id + argument sizes so a partially-streamed call re-diffs as
// its arguments fill in, but a settled call's diff is computed only once.
const diffCache = new Map();

function diffFor(block) {
  const info = editDiffInfo(block.name, block.arguments);
  if (!info) return null;
  const key = `${block.id}:${info.hunks.map((h) => `${h.oldText.length}:${h.newText.length}`).join(",")}`;
  let d = diffCache.get(key);
  if (!d) {
    let adds = 0;
    let dels = 0;
    const hunks = info.hunks.map((h) => {
      const rows = lineDiff(h.oldText, h.newText);
      adds += rows.filter((r) => r.type === "add").length;
      dels += rows.filter((r) => r.type === "del").length;
      return collapseRows(rows);
    });
    d = { path: info.path, hunks, adds, dels };
    diffCache.set(key, d);
  }
  return d;
}
</script>

<template>
  <div v-if="message.role === 'compactionSummary'" class="msg msg-compaction">
    <div class="compaction-divider">Session compacted ({{ message.tokensBefore }} tokens summarized)</div>
    <div class="markdown" v-html="renderMarkdown(message.summary)"></div>
  </div>
  <div v-else class="msg" :class="message.role === 'user' ? 'msg-user' : 'msg-assistant'">
    <div class="msg-actions">
      <button
        v-if="messageText"
        type="button"
        class="msg-action"
        :class="{ copied }"
        :title="copied ? 'Copied' : 'Copy message'"
        @click="copyMessage"
      >
        <svg v-if="!copied" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        v-if="message.role === 'user' && forkEntryId"
        type="button"
        class="msg-action"
        :disabled="forking"
        title="Edit &amp; resend (forks the chat from this message)"
        @click="editResend"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M11.3 2.3a1.5 1.5 0 0 1 2.1 2.1L5.5 12.3 2.5 13.2l.9-3L11.3 2.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <template v-for="(block, i) in blocks" :key="i">
      <div
        v-if="block.type === 'text' && message.role !== 'user'"
        class="markdown"
        v-html="renderMarkdown(block.text)"
        @click="onMarkdownClick"
      ></div>
      <span v-else-if="block.type === 'text'">{{ block.text }}</span>

      <img
        v-else-if="block.type === 'image'"
        class="msg-image"
        :src="`data:${block.mimeType};base64,${block.data}`"
        alt=""
      />

      <div
        v-else-if="block.type === 'thinking'"
        class="thinking markdown"
        v-html="renderMarkdown(block.thinking)"
        @click="onMarkdownClick"
      ></div>

      <SubagentView
        v-else-if="block.type === 'toolCall' && isSubagent(block)"
        :tool-call-id="block.id"
        :args="block.arguments"
      />

      <!-- edit/write tool call: collapsed unified diff instead of raw args -->
      <details
        v-else-if="block.type === 'toolCall' && diffFor(block)"
        class="tool tool-diff"
        :class="{ error: toolResult(block.id)?.isError, serena: isSerenaTool(block.name) }"
      >
        <summary title="Click to expand/collapse">
          <span class="tool-name" :title="block.name">{{ block.name }}</span>
          <span class="diff-path">{{ diffFor(block).path || "" }}</span>
          <span class="diff-stat">
            <span class="diff-stat-add">+{{ diffFor(block).adds }}</span>
            <span class="diff-stat-del">−{{ diffFor(block).dels }}</span>
          </span>
          <span v-if="toolResult(block.id)?.running" class="running" title="Running">⋯</span>
        </summary>
        <div class="diff">
          <template v-for="(segments, hi) in diffFor(block).hunks" :key="hi">
            <div v-if="hi > 0" class="diff-hunk-sep"></div>
            <template v-for="(row, ri) in segments" :key="ri">
              <div v-if="row.type === 'skip'" class="diff-skip">⋯ {{ row.count }} unchanged lines</div>
              <div v-else class="diff-line" :class="row.type">
                <span class="diff-sign">{{ row.type === "add" ? "+" : row.type === "del" ? "−" : " " }}</span
                >{{ row.text }}
              </div>
            </template>
          </template>
        </div>
        <pre v-if="toolResult(block.id)?.isError && toolResult(block.id)?.text">{{ toolResult(block.id).text }}</pre>
      </details>

      <details
        v-else-if="block.type === 'toolCall'"
        class="tool"
        :class="{ error: toolResult(block.id)?.isError, serena: isSerenaTool(block.name) }"
      >
        <summary title="Click to expand/collapse">
          <span class="tool-name" :title="block.name">{{ block.name }}</span>
          {{ argsSummary(block.arguments) }}
          <span v-if="toolResult(block.id)?.running" class="running" title="Running">⋯</span>
        </summary>
        <pre v-if="toolResult(block.id)?.text">{{ toolResult(block.id).text }}</pre>
      </details>
    </template>

    <button
      v-if="handover && !store.streaming"
      type="button"
      class="handover-continue"
      title="Open a new chat with this handover attached"
      @click="continueFromHandover(messageText)"
    >
      Continue in new chat
      <span>{{ handover.label }}</span>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

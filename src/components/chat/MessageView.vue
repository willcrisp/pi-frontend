<!--
  MessageView component: renders a single message (user or assistant) from OpenCode V2.
  Iterates message.parts (near-verbatim OpenCode API parts) and renders each by type:
  text, reasoning, tool (with pending/running/completed/error state), and file. step-start/
  step-finish parts are structural markers and render nothing. Falls back to the message's
  flattened `text` field when `parts` is empty (e.g. legacy/optimistic messages).

  A tool call whose arguments look like a file edit renders as a diff instead of
  a wall of raw output — see lib/diff.js for the detection, which goes by
  argument shape rather than a tool-name list.
-->
<script setup>
import { computed } from "vue";
import { renderMarkdown } from "../../lib/markdown.js";
import { onMarkdownClick } from "../../lib/codeCopy.js";
import { collapseRows, editDiffInfo, lineDiff } from "../../lib/diff.js";
import { isSubagentPart, stageRevert } from "../../stores/opencode.js";
import { filePathFromToolInput, openPreview } from "../../stores/filepreview.js";
import { handoverForMessage, isHandoverRequest } from "../../stores/handover.js";
import SubagentView from "./SubagentView.vue";
import HandoverChip from "./HandoverChip.vue";

const props = defineProps({
  message: { type: Object, required: true },
});

const isUser = computed(() => props.message.role === "user");

// Set when this message's text is a filed handover document (stores/handover.js),
// which gets a chip carrying its id. Keyed on the server's message id, so the
// chip comes back after a reload rather than living only in the session that
// produced it.
const handover = computed(() => handoverForMessage(props.message.id));

// The /handover brief is a real user turn, and it is three thousand characters
// of instructions to the agent — reproducing it in the transcript buries the
// document it asked for. Collapsed to a marker line.
const isHandoverBrief = computed(() => isUser.value && isHandoverRequest(props.message.text));

const hasParts = computed(
  () => Array.isArray(props.message.parts) && props.message.parts.length > 0
);

const renderedText = computed(() => renderMarkdown(props.message.text || ""));

function renderPart(text) {
  return renderMarkdown(text || "");
}

function isImagePart(part) {
  return !!part.url && (part.mime || "").startsWith("image/");
}

function truncate(text) {
  if (!text) return "";
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

// --- edit/write tool calls as diffs -----------------------------------------

// Unchanged lines kept either side of a change.
const DIFF_CONTEXT = 3;

// Keyed on the tool call's `input` object, which is set once (from
// session.tool.input.ended, and deliberately not clobbered by
// session.tool.called) and then never replaced. The *part* object around it is
// replaced on every upsert, so without this the diff would be recomputed for
// every edit in the message on every streaming text delta.
const diffCache = new WeakMap();

function buildDiff(info) {
  let added = 0;
  let removed = 0;
  const hunks = info.hunks.map((h) => {
    const rows = lineDiff(h.oldText, h.newText);
    for (const row of rows) {
      if (row.type === "add") added += 1;
      else if (row.type === "del") removed += 1;
    }
    return collapseRows(rows, DIFF_CONTEXT);
  });
  return { path: info.path, hunks, added, removed };
}

// The rendered diff for an edit-shaped tool call, or null when the call isn't
// one. Safe to call repeatedly from the template — every answer is memoized.
function diffFor(part) {
  const input = part.input;
  if (!input || typeof input !== "object") return null;
  if (diffCache.has(input)) return diffCache.get(input);
  const info = editDiffInfo(part.tool, input);
  const built = info ? buildDiff(info) : null;
  diffCache.set(input, built);
  return built;
}

const DIFF_SIGN = { add: "+", del: "−" };

function diffSign(type) {
  return DIFF_SIGN[type] || " ";
}

// V2 has no fork endpoint; staging a revert to this message is the closest
// thing to branching from it. Offered on user messages only — those are the
// points a user actually thinks in terms of going back to. Staging is
// reversible (clear discards it), so it needs no confirmation of its own.
function revertToHere() {
  if (props.message.id) stageRevert(props.message.id);
}
</script>

<template>
  <!-- Delegated so the copy buttons inside every v-html markdown block work;
       clicks that miss one pass straight through. -->
  <div class="msg" :class="isUser ? 'msg-user' : 'msg-assistant'" @click="onMarkdownClick">
    <button
      v-if="isUser && message.id"
      class="msg-revert"
      type="button"
      title="Stage a revert back to this message"
      @click="revertToHere"
    >
      ↩ revert here
    </button>
    <div v-if="isHandoverBrief" class="handover-brief" title="/handover — the full brief was sent to the agent">
      ⇥ handover requested
    </div>
    <template v-else-if="hasParts">
      <!-- REST-normalized parts carry no `id` (only tool parts get a callID),
           so fall back to the index to keep keys distinct. -->
      <template v-for="(part, pi) in message.parts" :key="part.id || part.callID || pi">
        <!-- text -->
        <div v-if="part.type === 'text' && isUser" class="user-text">{{ part.text }}</div>
        <div
          v-else-if="part.type === 'text'"
          class="markdown"
          v-html="renderPart(part.text)"
        ></div>

        <!-- reasoning -->
        <div v-else-if="part.type === 'reasoning'" class="thinking markdown" v-html="renderPart(part.text)"></div>

        <!-- subagent dispatch: rendered as a rich card driven by the child
             session the call spawned, not as a generic tool row -->
        <!-- `:callID`, not `:call-id`: kebab-case camelizes to `callId`, which
             does not match the declared `callID` prop, so the card silently
             received undefined — and with no callID it could never find its
             child session, leaving every dispatch stuck on "starting". -->
        <SubagentView
          v-else-if="isSubagentPart(part)"
          :callID="part.callID"
          :args="part.input"
          :state="part.state"
        />

        <!-- edit/write tool call: rendered as a diff rather than raw output.
             Detection is by argument shape (lib/diff.js), so a custom
             edit-like tool gets the same treatment as the built-in one. -->
        <details
          v-else-if="part.type === 'tool' && diffFor(part)"
          class="tool tool-diff"
          :class="{ error: part.state?.status === 'error' }"
        >
          <summary title="Click to expand/collapse">
            <span class="tool-name" :title="part.tool">{{ part.tool }}</span>
            <button
              v-if="diffFor(part).path"
              class="diff-path"
              type="button"
              :title="`Preview ${diffFor(part).path}`"
              @click.stop.prevent="openPreview(diffFor(part).path)"
            >
              {{ diffFor(part).path }}
            </button>
            <span class="diff-stat">
              <span v-if="diffFor(part).added" class="diff-stat-add">+{{ diffFor(part).added }}</span>
              <span v-if="diffFor(part).removed" class="diff-stat-del">−{{ diffFor(part).removed }}</span>
            </span>
            <span v-if="part.state?.status === 'running' || part.state?.status === 'pending'" class="running" title="Running">⋯</span>
          </summary>
          <!-- One block per hunk: a multi-edit call against a single file
               arrives as several old/new pairs. -->
          <div v-for="(hunk, hi) in diffFor(part).hunks" :key="hi" class="diff">
            <template v-for="(row, ri) in hunk" :key="ri">
              <div v-if="row.type === 'skip'" class="diff-skip">
                ⋯ {{ row.count }} unchanged {{ row.count === 1 ? "line" : "lines" }}
              </div>
              <div v-else class="diff-line" :class="row.type">
                <span class="diff-sign">{{ diffSign(row.type) }}</span>
                <span class="diff-text">{{ row.text }}</span>
              </div>
            </template>
          </div>
          <pre v-if="part.state?.status === 'error'">{{ truncate(part.state.error) }}</pre>
        </details>

        <!-- tool -->
        <details v-else-if="part.type === 'tool'" class="tool" :class="{ error: part.state?.status === 'error' }">
          <summary title="Click to expand/collapse">
            <span class="tool-name" :title="part.tool">{{ part.tool }}</span>
            <!-- Tool calls that name a file get a shortcut into the preview
                 pane, so following a reference doesn't mean leaving the app.
                 .stop keeps the click from toggling the <details>. -->
            <button
              v-if="filePathFromToolInput(part.input)"
              class="tool-file-link"
              type="button"
              :title="`Preview ${filePathFromToolInput(part.input)}`"
              @click.stop.prevent="openPreview(filePathFromToolInput(part.input))"
            >
              {{ filePathFromToolInput(part.input) }}
            </button>
            <span v-if="part.state?.status === 'running' || part.state?.status === 'pending'" class="running" title="Running">⋯</span>
          </summary>
          <pre v-if="part.state?.status === 'completed'">{{ truncate(part.state.output) }}</pre>
          <pre v-else-if="part.state?.status === 'error'">{{ truncate(part.state.error) }}</pre>
        </details>

        <!-- file: images render as a thumbnail, anything else as a name chip -->
        <a
          v-else-if="part.type === 'file' && isImagePart(part)"
          class="msg-image"
          :href="part.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img :src="part.url" :alt="part.filename || part.mime" />
        </a>
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

    <HandoverChip v-if="handover" :record="handover" />
  </div>
</template>

<style scoped>
.handover-brief {
  color: var(--dim);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.02em;
}

/* Kept out of the way until the message is hovered — it's a destructive-ish
   action sitting next to every user turn. */
.msg-revert {
  float: right;
  margin-left: 8px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}

.msg:hover .msg-revert {
  opacity: 1;
}

.msg-revert:hover {
  color: var(--fg);
  border-color: #2c3540;
}

/* styles/diff.css styles `.diff-path` as a plain label; it's a button here so
   the path doubles as the shortcut into the preview pane, which means undoing
   the button chrome. */
.diff-path {
  padding: 0;
  border: 0;
  background: none;
  font-family: var(--mono);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.diff-path:hover {
  color: var(--accent);
  text-decoration: underline;
}

/* Lets a long line wrap inside the flex row rather than forcing it wider. */
.diff-text {
  flex: 1;
  min-width: 0;
}

.tool-file-link {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.tool-file-link:hover {
  color: var(--accent);
  text-decoration: underline;
}

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

.msg-image {
  display: block;
  max-width: 320px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.msg-image img {
  display: block;
  max-width: 100%;
  height: auto;
}

a.msg-file:hover {
  color: var(--fg);
  border-color: #2c3540;
}
</style>

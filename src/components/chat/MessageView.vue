<!--
  MessageView component: renders a single message (user or assistant) from OpenCode V2.
  Iterates message.parts (near-verbatim OpenCode API parts) and renders each by type:
  text, reasoning, tool (with pending/running/completed/error state), and file. step-start/
  step-finish parts are structural markers and render nothing. Falls back to the message's
  flattened `text` field when `parts` is empty (e.g. legacy/optimistic messages).

  A tool call whose arguments look like a file edit renders as a diff instead of
  a wall of raw output — see lib/diff.js for the detection, which goes by
  argument shape rather than a tool-name list.

  A tool call whose result carries image blocks (a `read` of an image file is
  the common case) renders those images inline beneath the tool row — see
  toolImages(), which reads blocks both ingest paths already retain on
  part.state.content, so this is purely a render change.
-->
<script setup>
import { computed } from "vue";
import { renderMarkdown } from "../../lib/markdown.js";
import { onMarkdownClick } from "../../lib/codeCopy.js";
import { collapseRows, editDiffInfo, lineDiff } from "../../lib/diff.js";
import { isSubagentPart, opencodeStore as store, stageRevert } from "../../stores/opencode.js";
import { filePathFromToolInput, openPreview } from "../../stores/filepreview.js";
import { handoverForMessage, isHandoverRequest } from "../../stores/handover.js";
import { mcpServerOf } from "../../stores/mcp.js";
import SubagentView from "./SubagentView.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import QuestionPart from "./QuestionPart.vue";
import HandoverChip from "./HandoverChip.vue";
import WebSearchPart from "./WebSearchPart.vue";

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

// A reasoning part is still streaming when it's the last part of the last
// message of a run in flight. Only that one previews its tail and follows itself
// (ThinkingBlock); a sub-agent's transcript renders through the same component
// but isn't the session's own stream, so nothing there is ever "live".
function isLivePart(index) {
  return (
    store.isStreaming &&
    store.messages.at(-1) === props.message &&
    index === props.message.parts.length - 1
  );
}

function truncate(text) {
  if (!text) return "";
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function toolInputText(input) {
  if (input == null || input === "") return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toolOutputText(part) {
  const state = part.state || {};
  const value = state.output || state.result || (state.content && (Array.isArray(state.content)
    ? state.content.map((item) => item?.text || "").filter(Boolean).join("\n")
    : state.content));
  if (!value) return "";
  return typeof value === "string" ? value : toolInputText(value);
}

// --- tool calls that return images ------------------------------------------

// A block's URL only goes into <img src>/<a href> for schemes that render an
// image. The content comes from tool results — and an MCP server is third
// party — so anything else (javascript: is the dangerous one) is dropped.
const SAFE_IMAGE_URL = /^(data:image\/|https?:|blob:)/i;

// One content block's image URL, or null when it isn't an image block. The V2
// `read` tool on an image file returns
//   [{type:"text", text:"Image read successfully"},
//    {type:"file", uri:"data:image/png;base64,…", mime:"image/png", name: path}]
// (see docs/opencode-api.md), but other tools spell blocks differently (MCP
// screenshot tools use image/media blocks with data+mimeType), so this is
// tolerant rather than matching one shape exactly.
function imageBlockUrl(item) {
  if (!item || typeof item !== "object") return null;
  if (!["file", "image", "media"].includes(item.type)) return null;
  const mime = item.mime || item.mimeType || item.mediaType || "";
  if (mime && !String(mime).startsWith("image/")) return null;
  // A `file` block without an image mime is an attachment, not a picture.
  if (item.type === "file" && !mime) return null;
  let url = typeof item.uri === "string" ? item.uri : typeof item.url === "string" ? item.url : "";
  if (!url) {
    const data =
      typeof item.data === "string" ? item.data : typeof item.image === "string" ? item.image : "";
    if (data) url = SAFE_IMAGE_URL.test(data) ? data : `data:${mime || "image/png"};base64,${data}`;
  }
  return url && SAFE_IMAGE_URL.test(url) ? url : null;
}

// The images a tool call returned, read from part.state.content — which both
// ingest paths (SSE session.tool.success and REST history normalization)
// already retain on the part, so no wire-level change was needed.
function toolImages(part) {
  const content = part.state && part.state.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => {
      const url = imageBlockUrl(item);
      return url ? { url, name: typeof item.name === "string" ? item.name : "" } : null;
    })
    .filter(Boolean);
}

function isWebSearchPart(part) {
  return part.tool === "websearch" || part.tool === "web_search";
}

function webSearchSources(part) {
  if (!isWebSearchPart(part)) return [];
  const text = toolOutputText(part);
  if (!text) return [];
  const sources = [];
  const seen = new Set();
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = markdown.exec(text))) {
    const url = match[2].replace(/[.,;:]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      sources.push({ title: match[1], url });
    }
  }
  const urls = text.match(/https?:\/\/[^\s<>'"`)\]]+/g) || [];
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      sources.push({ title: "", url });
    }
  }
  return sources;
}

// MCP tool calls are named `<server>_<tool>` by the server (e.g.
// `serena_find_referencing_symbols`), so the prefix identifies which MCP server
// a call came from — and the display name drops it, since the card already says
// which server. Which prefixes are servers comes from stores/mcp.js (`GET /mcp`)
// rather than a literal here: this list was `["serena"]` hardcoded, so the
// stripping and the accent worked for exactly one install.
//
// A server with a `tool-mcp-<name>` rule in styles/tool-calls.css also gets an
// accent colour; the rest just get their prefix tidied.
function mcpToolClass(part) {
  const s = mcpServerOf(part.tool);
  return s ? `tool-mcp-${s}` : "";
}
function displayToolName(part) {
  const s = mcpServerOf(part.tool);
  return s ? part.tool.slice(s.length + 1) : part.tool;
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

        <!-- reasoning: a collapsed quote, click to expand — see ThinkingBlock -->
        <ThinkingBlock
          v-else-if="part.type === 'reasoning'"
          :text="part.text"
          :live="isLivePart(pi)"
        />

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

        <!-- question: the agent asked a structured question mid-execution.
             Rendered as an inline Q&A card — clickable options while it waits
             for an answer, checked-off answers once it settles. -->
        <QuestionPart
          v-else-if="part.type === 'tool' && part.tool === 'question'"
          :part="part"
        />

        <!-- Searches stay visible while they run and render their sources as
             browsable pages instead of a generic tool payload. -->
        <WebSearchPart
          v-else-if="part.type === 'tool' && isWebSearchPart(part)"
          :part="part"
        />

        <!-- edit/write tool call: rendered as a diff rather than raw output.
             Detection is by argument shape (lib/diff.js), so a custom
             edit-like tool gets the same treatment as the built-in one. -->
        <details
          v-else-if="part.type === 'tool' && diffFor(part)"
          class="tool tool-diff"
          :class="[ { error: part.state?.status === 'error' }, mcpToolClass(part) ]"
        >
          <summary title="Click to expand/collapse">
            <span v-if="mcpServerOf(part.tool)" class="mcp-chip">{{ mcpServerOf(part.tool) }}</span>
            <span class="tool-name" :title="part.tool">{{ displayToolName(part) }}</span>
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
        <template v-else-if="part.type === 'tool'">
          <details class="tool" :class="[ { error: part.state?.status === 'error' }, mcpToolClass(part) ]">
            <summary title="Click to expand/collapse">
              <span v-if="mcpServerOf(part.tool)" class="mcp-chip">{{ mcpServerOf(part.tool) }}</span>
              <span class="tool-name" :title="part.tool">{{ displayToolName(part) }}</span>
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
            <pre v-if="part.state?.status === 'completed'">{{ truncate(toolOutputText(part)) }}</pre>
            <pre v-else-if="part.state?.status === 'error'">{{ truncate(part.state.error) }}</pre>
            <pre v-else-if="part.input">{{ truncate(toolInputText(part.input)) }}</pre>
          </details>
          <!-- Images the call returned (a `read` of an image file, a
               screenshot MCP tool) render inline beneath the row — visible
               without expanding, like user-attached images (.msg-image). -->
          <div v-if="toolImages(part).length" class="tool-images">
            <a
              v-for="(img, ii) in toolImages(part)"
              :key="ii"
              class="tool-image"
              :href="img.url"
              :title="img.name || 'Open image'"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img :src="img.url" :alt="img.name || 'Tool image'" loading="lazy" />
            </a>
          </div>
        </template>

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
      <div v-if="!isUser && message.error" class="msg-error">{{ message.error }}</div>
    </template>
    <div v-else-if="!isUser && message.error" class="msg-error">{{ message.error }}</div>

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
/* `visibility: hidden`, not `opacity: 0`.

   Staging a revert is the one destructive thing you can do from the transcript,
   and with opacity alone this button was a 95px hit target that was present,
   clickable and in the tab order on EVERY user message while invisible —
   document.elementFromPoint at its centre returned the button. It also still
   occupied layout: floated right on the first line, it consumed the whole line
   in a narrow column, which is why user prompts wrapped after their first
   character at small widths.

   `visibility` takes it out of hit-testing and the tab order; `position:
   absolute` takes it out of the text flow. `focus-within` keeps it reachable by
   keyboard, so it is hidden without becoming mouse-only. */
.msg {
  position: relative;
}

.msg-revert {
  position: absolute;
  top: 0;
  right: 0;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.12s;
}

.msg:hover .msg-revert,
.msg:focus-within .msg-revert,
.msg-revert:focus-visible {
  visibility: visible;
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

.msg-error {
  margin: 6px 0;
  padding: 7px 10px;
  background: rgba(247, 118, 142, 0.08);
  border: 1px solid var(--error);
  border-radius: 6px;
  color: var(--error);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.mcp-chip {
  display: inline-flex;
  align-items: center;
  margin-right: 6px;
  padding: 0 6px;
  border: 1px solid rgba(224, 175, 104, 0.45);
  border-radius: 999px;
  background: rgba(224, 175, 104, 0.1);
  color: var(--msg-tool-serena);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  vertical-align: middle;
}
</style>

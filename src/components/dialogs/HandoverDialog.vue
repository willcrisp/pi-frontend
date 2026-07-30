<!--
  The handover dialog: what a chip click opens.

  Shows the document the agent wrote, and takes the extra instructions that get
  appended to the prompt seeding the new chat. Confirming creates a session in
  the same project and sends it the seed — see stores/handover.js.

  The document is shown rendered rather than raw because it is meant to be read
  here (it is the last chance to notice the agent got something wrong), with a
  toggle to the markdown source for copying it elsewhere.

  Chrome is the shared connect-dialog panel, as ConfirmDialog does; only the
  wider layout and the document pane are local.
-->
<script setup>
import { computed, nextTick, onMounted, ref } from "vue";
import {
  closeHandover,
  handoverById,
  handoverStore,
  startHandoverChat,
} from "../../stores/handover.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { onMarkdownClick } from "../../lib/codeCopy.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

// On `window`, not the backdrop: see the note in useDialogEscape.
const { onBackdrop } = useDialogEscape(() => closeHandover());

const record = computed(() => handoverById(handoverStore.openId));
const rendered = computed(() => renderMarkdown(record.value?.body || ""));

const extra = ref("");
const showSource = ref(false);
const copied = ref(false);
const extraEl = ref(null);

// Focused on open: the one thing this dialog exists to collect is what the user
// wants to add, and a dialog that opens with the cursor already in the box says
// so without a label having to.
onMounted(() => {
  nextTick(() => extraEl.value?.focus());
});

async function copyDocument() {
  if (!record.value) return;
  try {
    await navigator.clipboard.writeText(record.value.body);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    /* clipboard blocked (insecure context / denied) — the source view is the fallback */
  }
}

function start() {
  startHandoverChat(extra.value);
}

// Ctrl/Cmd+Enter sends from the textarea, matching the composer's "Enter
// commits" reflex without stealing plain Enter from a multi-line note.
function onExtraKeydown(e) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    start();
  }
}
</script>

<template>
  <div
    v-if="record"
    class="connect-backdrop"
    @mousedown="onBackdrop"
  >
    <div class="connect-panel handover-panel">
      <div class="connect-head">
        <span>
          Handover <code class="handover-id">{{ record.id }}</code>
        </span>
        <button class="connect-close" title="Close" @click="closeHandover">✕</button>
      </div>

      <div class="handover-meta">
        <span v-if="record.title">from “{{ record.title }}”</span>
        <span v-if="record.directory" class="handover-dir" :title="record.directory">
          {{ record.directory }}
        </span>
      </div>

      <div class="handover-doc-head">
        <span>{{ showSource ? "Markdown source" : "Handover document" }}</span>
        <div class="handover-doc-actions">
          <button type="button" class="connect-secondary" @click="showSource = !showSource">
            {{ showSource ? "Rendered" : "Source" }}
          </button>
          <button type="button" class="connect-secondary" @click="copyDocument">
            {{ copied ? "Copied" : "Copy" }}
          </button>
        </div>
      </div>

      <!-- Delegated so the copy buttons renderMarkdown plants in code blocks
           work here too, exactly as they do in the transcript. -->
      <div class="handover-doc" @click="onMarkdownClick">
        <pre v-if="showSource" class="handover-source">{{ record.body }}</pre>
        <div v-else class="markdown" v-html="rendered"></div>
      </div>

      <label class="handover-extra-label" for="handover-extra">
        Anything to add? (optional — appended to the prompt the new chat starts with)
      </label>
      <textarea
        id="handover-extra"
        ref="extraEl"
        v-model="extra"
        class="connect-filter handover-extra"
        rows="3"
        placeholder="e.g. skip the CSS work, start with the failing test in test/handover.spec.js"
        @keydown="onExtraKeydown"
      ></textarea>

      <div class="connect-actions">
        <button type="button" :disabled="handoverStore.starting" @click="start">
          {{ handoverStore.starting ? "Starting…" : "Start new chat" }}
        </button>
        <button type="button" class="connect-secondary" @click="closeHandover">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Wider than the shared panel, and the panel itself stops scrolling — the
   document pane below owns the overflow, so the header and the actions stay
   put while a long handover is scrolled. */
.handover-panel {
  width: 760px;
  max-height: 86vh;
  overflow: hidden;
}

.handover-id {
  font-family: var(--mono);
  color: var(--accent);
  letter-spacing: 0.04em;
}

.handover-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: -6px;
  color: var(--dim);
  font-size: 11.5px;
}

.handover-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.handover-doc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--dim);
  font-size: 11.5px;
}

.handover-doc-actions {
  display: flex;
  gap: 4px;
}

.handover-doc-actions button {
  font-size: 11px;
  padding: 2px 8px;
}

.handover-doc {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.handover-source {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--dim);
}

.handover-extra-label {
  color: var(--dim);
  font-size: 11.5px;
}

.handover-extra {
  resize: vertical;
  min-height: 54px;
  font-family: var(--mono);
}
</style>

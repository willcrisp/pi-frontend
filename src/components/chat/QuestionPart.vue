<!--
  A `question` tool call, rendered as an inline Q&A card in the transcript.

  The ask itself is a modal (QuestionDialog) — it blocks a run, so it has to be
  impossible to miss. But the modal is a poor record of what happened: it
  disappears the moment it is answered, leaving a collapsed tool row where the
  decision was, and on reload there is nothing to show that a choice was ever
  made. Scrolling back through a session to find "what did I tell it to do?" is
  a normal thing to want.

  So the tool call renders here as well, in place, in both of its lives:

    pending  — the options are live. Answering from the card is the same POST
               the dialog makes (stores/question.js owns it either way), so
               whichever the user reaches for, the other settles with it.
    settled  — the questions with the answers checked off, read from
               `state.metadata.answers`, which the server puts on the tool
               result. That survives a transcript refresh; the queue entry does
               not.

  App.vue suppresses the modal while its ask is on screen as a card (see
  `inlineQuestion` there) so the two never compete for the same decision. The
  modal stays the fallback for an ask whose tool part isn't in view — a
  sub-agent's, another session's, or one the stream never delivered.
-->
<script setup>
import { computed, ref, watch } from "vue";
import { questionStore, reply, reject } from "../../stores/question.js";

const props = defineProps({
  part: { type: Object, required: true },
});

const state = computed(() => props.part.state || {});

// The queue entry this call is waiting on, if it is still waiting. Matched by
// callID: the ask carries the tool call it came from, which is the only thing
// tying a queue entry to a part.
const pending = computed(
  () =>
    questionStore.queue.find(
      (entry) => entry.tool && entry.tool.callID && entry.tool.callID === props.part.callID
    ) || null
);

// --- The questions -----------------------------------------------------------

function normalizeOption(opt) {
  if (typeof opt === "string") return opt ? { label: opt, description: "" } : null;
  if (!opt || typeof opt !== "object") return null;
  const label = typeof opt.label === "string" ? opt.label : "";
  return label ? { label, description: opt.description || "" } : null;
}

// The settled path reads the arguments the tool was called with, which are the
// raw `QuestionV2.Info` shape rather than the store's normalized one.
function normalizeQuestion(info) {
  if (!info || typeof info !== "object") return null;
  const options = Array.isArray(info.options)
    ? info.options.map(normalizeOption).filter(Boolean)
    : [];
  return {
    question: info.question || "",
    header: info.header || "",
    options,
    multiple: info.multiple === true,
    custom: info.custom === true || options.length === 0,
  };
}

// While pending, the queue entry is authoritative — it is what the reply will
// be keyed against. Once settled, the tool call's own input is all that is left.
const questions = computed(() => {
  if (pending.value) return pending.value.questions;
  const input = props.part.input;
  const list = input && typeof input === "object" ? input.questions : null;
  return Array.isArray(list) ? list.map(normalizeQuestion).filter(Boolean) : [];
});

// Positional over `questions`, the same way the reply body is.
const answers = computed(() => {
  const meta = state.value.metadata;
  const list = meta && Array.isArray(meta.answers) ? meta.answers : null;
  if (!list) return [];
  return list.map((a) => (Array.isArray(a) ? a : a == null ? [] : [String(a)]));
});

const settled = computed(() => !pending.value && state.value.status === "completed");

// --- Answering ---------------------------------------------------------------

// Parallel to `questions`: chosen option labels, and the free-text answer.
const picked = ref([]);
const customText = ref([]);

// Reset whenever this card starts (or stops) driving an ask, so a half-made
// choice never carries into a different one.
watch(
  pending,
  (entry) => {
    const count = entry ? entry.questions.length : 0;
    picked.value = Array.from({ length: count }, () => []);
    customText.value = Array.from({ length: count }, () => "");
  },
  { immediate: true }
);

function answerFor(i) {
  const custom = (customText.value[i] || "").trim();
  const labels = picked.value[i] || [];
  if (!custom || labels.includes(custom)) return [...labels];
  return [...labels, custom];
}

const complete = computed(
  () => questions.value.length > 0 && questions.value.every((q, i) => answerFor(i).length > 0)
);

function isPicked(i, label) {
  return (picked.value[i] || []).includes(label);
}

function toggle(i, label) {
  const chosen = picked.value[i] || [];
  if (questions.value[i].multiple) {
    picked.value[i] = chosen.includes(label)
      ? chosen.filter((l) => l !== label)
      : [...chosen, label];
    return;
  }
  // Single-select: one option wins, and it supersedes any free text typed.
  picked.value[i] = [label];
  customText.value[i] = "";
}

// The whole batch renders at once here (unlike the modal, which steps through
// it), so a click can only be the whole answer when there is exactly one
// question and nothing else to type into it. Anything else waits for Submit —
// a stray click must not send a half-made batch.
function autoSubmits() {
  const q = questions.value;
  return q.length === 1 && !q[0].multiple && !q[0].custom;
}

function choose(i, label) {
  if (!pending.value || pending.value.busy) return;
  toggle(i, label);
  if (autoSubmits()) submit();
}

function onCustomInput(i) {
  // Free text supersedes a single-select option the same way an option
  // supersedes free text.
  if (!questions.value[i].multiple && (customText.value[i] || "").trim()) picked.value[i] = [];
}

function submit() {
  const entry = pending.value;
  if (!entry || entry.busy || !complete.value) return;
  reply(entry.id, entry.questions.map((q, i) => answerFor(i)));
}

function skip() {
  const entry = pending.value;
  if (entry && !entry.busy) reject(entry.id);
}

// An option that was chosen, once the ask has settled.
function wasChosen(i, label) {
  return (answers.value[i] || []).includes(label);
}

// Answers that match no option: whatever was typed into the free-text box.
function customAnswers(i) {
  const q = questions.value[i];
  const labels = new Set((q.options || []).map((o) => o.label));
  return (answers.value[i] || []).filter((a) => !labels.has(a));
}
</script>

<template>
  <div v-if="questions.length" class="question-part" :class="{ answered: settled }">
    <div class="question-part-head">
      <span class="question-part-icon" aria-hidden="true">?</span>
      <span class="question-part-label">{{ pending ? "Waiting on you" : "Asked" }}</span>
      <span v-if="pending && pending.busy" class="question-part-busy">sending…</span>
    </div>

    <p v-if="pending && pending.error" class="question-part-error">{{ pending.error }}</p>

    <div v-for="(q, i) in questions" :key="i" class="question-part-item">
      <p v-if="q.header" class="question-part-header">{{ q.header }}</p>
      <p v-if="q.question" class="question-part-text">{{ q.question }}</p>

      <ul v-if="q.options.length" class="question-part-options">
        <li v-for="opt in q.options" :key="opt.label">
          <!-- Once settled the options are a record, not a control: rendered as
               a static row so nothing here looks like it can still be clicked. -->
          <button
            v-if="pending"
            type="button"
            class="question-part-option"
            :class="{ picked: isPicked(i, opt.label) }"
            :disabled="pending.busy"
            @click="choose(i, opt.label)"
          >
            <span class="question-part-option-main">
              <span class="question-part-option-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="question-part-option-desc">{{ opt.description }}</span>
            </span>
            <span class="question-part-option-check">{{ isPicked(i, opt.label) ? "✓" : "" }}</span>
          </button>
          <div v-else class="question-part-option static" :class="{ chosen: wasChosen(i, opt.label) }">
            <span class="question-part-option-main">
              <span class="question-part-option-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="question-part-option-desc">{{ opt.description }}</span>
            </span>
            <span class="question-part-option-check">{{ wasChosen(i, opt.label) ? "✓" : "" }}</span>
          </div>
        </li>
      </ul>

      <label v-if="pending && q.custom" class="question-part-custom">
        <span class="question-part-custom-label">
          {{ q.options.length ? "Or answer in your own words" : "Your answer" }}
        </span>
        <input
          v-model="customText[i]"
          type="text"
          placeholder="Type an answer…"
          autocomplete="off"
          :disabled="pending.busy"
          @input="onCustomInput(i)"
          @keydown.enter.prevent="submit"
        />
      </label>

      <p v-else-if="!pending && customAnswers(i).length" class="question-part-typed">
        {{ customAnswers(i).join(", ") }}
      </p>

      <p v-if="pending && q.multiple" class="question-part-hint">Pick as many as apply.</p>
    </div>

    <div v-if="pending" class="question-part-actions">
      <button
        v-if="!autoSubmits()"
        type="button"
        :disabled="pending.busy || !complete"
        @click="submit"
      >
        Submit
      </button>
      <button type="button" class="connect-secondary" :disabled="pending.busy" @click="skip">
        Skip
      </button>
    </div>

    <!-- Rejected, or answered somewhere this card never saw: say so rather than
         showing a question with nothing checked and letting it read as ignored. -->
    <p v-else-if="settled && !answers.length" class="question-part-hint">
      Answered elsewhere — the choice wasn't recorded on this call.
    </p>
  </div>
</template>

<style scoped>
.question-part {
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-raised));
  overflow: hidden;
}

/* Settled, this is history: the accent that made it demand attention would keep
   drawing the eye to a decision already made. */
.question-part.answered {
  border-color: var(--border);
  background: var(--bg-raised);
}

.question-part-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 12.5px;
}

.question-part-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--bg);
  font-size: 10px;
  font-weight: 700;
}

.question-part.answered .question-part-icon {
  background: var(--dim);
}

.question-part-busy {
  margin-left: auto;
  color: var(--accent);
  font-size: 11px;
}

.question-part-error {
  margin: 0;
  padding: 0 10px 6px;
  color: var(--error);
  font-family: var(--mono);
  font-size: 11.5px;
}

.question-part-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 10px 10px;
}

.question-part-header {
  margin: 0;
  color: var(--dim);
  font-size: 11.5px;
}

.question-part-text {
  margin: 0;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.question-part-options {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
}

.question-part-option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

/* Hover stops short of the accent border that marks a selection — otherwise a
   merely hovered option reads as the chosen one. */
button.question-part-option:hover:not(:disabled),
button.question-part-option:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  outline: none;
}

.question-part-option.picked,
.question-part-option.chosen {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg));
}

.question-part-option.static {
  cursor: default;
}

/* An option that wasn't chosen is context for the one that was, not an equal
   sibling of it. */
.question-part-option.static:not(.chosen) {
  opacity: 0.55;
}

.question-part-option:disabled {
  cursor: default;
  opacity: 0.6;
}

.question-part-option-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.question-part-option-label {
  line-height: 1.5;
  word-break: break-word;
}

.question-part-option-desc {
  color: var(--dim);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
}

.question-part-option-check {
  flex-shrink: 0;
  min-width: 10px;
  color: var(--accent);
}

.question-part-custom {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.question-part-custom-label {
  color: var(--dim);
  font-size: 11.5px;
}

.question-part-custom input {
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  outline: none;
}

.question-part-custom input:focus {
  border-color: var(--accent);
}

.question-part-typed {
  margin: 0;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 11.5px;
}

.question-part-hint {
  margin: 0;
  padding: 0 10px 8px;
  color: var(--dim);
  font-size: 11.5px;
}

.question-part-item .question-part-hint {
  padding: 0;
}

.question-part-actions {
  display: flex;
  gap: 8px;
  padding: 0 10px 10px;
}

.question-part-actions button {
  font-size: 12px;
  padding: 4px 12px;
}
</style>

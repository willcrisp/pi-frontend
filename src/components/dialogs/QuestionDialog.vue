<!--
  Modal for answering the structured question(s) a tool asked mid-execution.
  Backed by stores/question.js — questionStore.queue is a FIFO of pending asks
  from `question.v2.asked`; this dialog always shows the queue head and
  advances as answers settle (see App.vue, which mounts it while the queue is
  non-empty).

  One ask can carry several questions, so this steps through them one at a time
  and POSTs every answer in a single reply at the end — that is the shape the
  API wants (`answers` is positional over `questions`) and it keeps each screen
  to a single decision.

  Per-question flags from `QuestionV2.Info` drive the input:
    multiple  — checkboxes and an explicit Continue, instead of click-to-answer
    custom    — an extra free-text answer alongside (or instead of) the options
  A question with no options is custom-only, so an unrecognised variant stays
  answerable rather than becoming a dead end.
-->
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { questionStore, reply, reject } from "../../stores/question.js";

const current = computed(() => questionStore.queue[0] || null);

const step = ref(0);
// Parallel to current.questions: chosen option labels, and the free-text
// answer, per question.
const picked = ref([]);
const customText = ref([]);
const customInput = ref(null);

const question = computed(() => current.value?.questions[step.value] || null);
const total = computed(() => current.value?.questions.length || 0);
const isLast = computed(() => step.value >= total.value - 1);

// Answers are identified by label, so that is what we collect and send.
const answer = computed(() => {
  if (!question.value) return [];
  const custom = (customText.value[step.value] || "").trim();
  const labels = picked.value[step.value] || [];
  if (!custom) return [...labels];
  return labels.includes(custom) ? [...labels] : [...labels, custom];
});

const canAdvance = computed(() => answer.value.length > 0);

function resetFor(entry) {
  step.value = 0;
  const count = entry?.questions.length || 0;
  picked.value = Array.from({ length: count }, () => []);
  customText.value = Array.from({ length: count }, () => "");
}

// Reset when the queue advances, so answers typed for one ask never leak into
// the next.
watch(current, (entry) => resetFor(entry), { immediate: true });

function isPicked(label) {
  return (picked.value[step.value] || []).includes(label);
}

function toggle(label) {
  const chosen = picked.value[step.value] || [];
  if (question.value.multiple) {
    picked.value[step.value] = chosen.includes(label)
      ? chosen.filter((l) => l !== label)
      : [...chosen, label];
    return;
  }
  // Single-select: one option wins, and it supersedes any free text typed.
  picked.value[step.value] = [label];
  customText.value[step.value] = "";
}

// A plain single-select is one decision, so a click is the whole answer — take
// it and move on rather than making the user confirm. Multi-select needs no
// explanation; `custom` also holds, because a free-text box next to the options
// means the user may still be composing, and a stray click must not submit the
// whole ask out from under them. Those two cases get the Continue button.
function autoAdvances() {
  return question.value && !question.value.multiple && !question.value.custom;
}

function choose(label) {
  if (current.value?.busy) return;
  toggle(label);
  if (autoAdvances()) advance();
}

function onCustomInput() {
  // Free text supersedes a single-select option the same way an option
  // supersedes free text.
  if (question.value && !question.value.multiple && (customText.value[step.value] || "").trim()) {
    picked.value[step.value] = [];
  }
}

function advance() {
  if (!canAdvance.value || current.value?.busy) return;
  if (isLast.value) {
    submit();
    return;
  }
  step.value += 1;
}

function back() {
  if (step.value > 0 && !current.value?.busy) step.value -= 1;
}

function submit() {
  const entry = current.value;
  if (!entry || entry.busy) return;
  const answers = entry.questions.map((q, i) => {
    const custom = (customText.value[i] || "").trim();
    const labels = picked.value[i] || [];
    if (!custom || labels.includes(custom)) return [...labels];
    return [...labels, custom];
  });
  reply(entry.id, answers);
}

function skip() {
  if (current.value && !current.value.busy) reject(current.value.id);
}

// Number keys pick an option, Enter continues, Escape skips the whole ask.
// Bail out while the free-text box has focus so typing "1" stays a "1".
function onKeydown(event) {
  if (!current.value) return;
  const typing = event.target === customInput.value;
  if (event.key === "Escape") {
    event.preventDefault();
    skip();
    return;
  }
  if (event.key === "Enter" && !typing) {
    event.preventDefault();
    advance();
    return;
  }
  if (typing) return;
  if (/^[1-9]$/.test(event.key)) {
    const opt = question.value?.options[Number(event.key) - 1];
    if (opt) {
      event.preventDefault();
      choose(opt.label);
    }
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

// Focus the box when free text is the only way to answer.
watch(
  question,
  (q) => {
    if (q && !q.options.length) nextTick(() => customInput.value?.focus());
  },
  { immediate: true }
);
</script>

<template>
  <div v-if="current && question" class="connect-backdrop">
    <div class="connect-panel question-panel">
      <div class="connect-head">
        <span>{{ question.header || "Question" }}</span>
        <span v-if="total > 1" class="question-progress">{{ step + 1 }} / {{ total }}</span>
      </div>

      <p v-if="current.error" class="connect-error">{{ current.error }}</p>

      <p class="question-text">{{ question.question }}</p>

      <ul v-if="question.options.length" class="question-options">
        <li v-for="(opt, i) in question.options" :key="opt.label">
          <button
            type="button"
            class="question-option"
            :class="{ picked: isPicked(opt.label) }"
            :disabled="current.busy"
            @click="choose(opt.label)"
          >
            <span class="question-option-key">{{ i + 1 }}</span>
            <span class="question-option-main">
              <span class="question-option-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="question-option-desc">{{ opt.description }}</span>
            </span>
            <span class="question-option-check">{{ isPicked(opt.label) ? "✓" : "" }}</span>
          </button>
        </li>
      </ul>

      <label v-if="question.custom" class="question-custom">
        <span class="question-custom-label">
          {{ question.options.length ? "Or answer in your own words" : "Your answer" }}
        </span>
        <input
          ref="customInput"
          v-model="customText[step]"
          type="text"
          placeholder="Type an answer…"
          autocomplete="off"
          :disabled="current.busy"
          @input="onCustomInput"
          @keydown.enter.prevent="advance"
        />
      </label>

      <p v-if="question.multiple" class="connect-hint">Pick as many as apply.</p>

      <div class="connect-actions">
        <button
          v-if="question.multiple || question.custom"
          type="button"
          :disabled="current.busy || !canAdvance"
          @click="advance"
        >
          {{ isLast ? "Submit" : "Continue" }}
        </button>
        <button
          v-if="step > 0"
          type="button"
          class="connect-secondary"
          :disabled="current.busy"
          @click="back"
        >
          Back
        </button>
        <span class="question-actions-spacer" />
        <button type="button" class="connect-secondary" :disabled="current.busy" @click="skip">
          Skip
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.question-panel {
  width: 520px;
}

.question-progress {
  color: var(--dim);
  font-size: 11.5px;
}

.question-text {
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.question-options {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
}

.question-option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

/* Hover deliberately stops short of the accent border that marks a selection —
   otherwise a merely hovered option reads as the chosen one. */
.question-option:hover:not(:disabled),
.question-option:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  outline: none;
}

.question-option.picked {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg));
}

.question-option:disabled {
  cursor: default;
  opacity: 0.6;
}

.question-option-key {
  flex-shrink: 0;
  min-width: 15px;
  color: var(--dim);
  font-size: 11px;
  line-height: 1.5;
}

.question-option-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.question-option-label {
  line-height: 1.5;
  word-break: break-word;
}

.question-option-desc {
  color: var(--dim);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
}

.question-option-check {
  flex-shrink: 0;
  color: var(--accent);
  min-width: 10px;
}

.question-custom {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.question-custom-label {
  color: var(--dim);
  font-size: 11.5px;
}

.question-custom input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  font: inherit;
  padding: 7px 9px;
  outline: none;
}

.question-custom input:focus {
  border-color: var(--accent);
}

.question-actions-spacer {
  flex: 1;
}
</style>

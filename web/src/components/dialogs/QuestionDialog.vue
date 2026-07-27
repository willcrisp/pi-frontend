<!--
  Modal for answering a structured question a tool asked mid-execution.
  Backed by stores/question.js — questionStore.queue is a FIFO of pending
  asks from `question.v2.asked`; this dialog always shows the queue head and
  advances as answers settle (see App.vue, which mounts it while the queue
  is non-empty).

  Unlike PermissionDialog's fixed once/always/reject, the answers here are
  server-supplied options. A question with no options degrades to a free-text
  box so an unrecognised variant is still answerable rather than a dead end.
-->
<script setup>
import { computed, ref, watch } from "vue";
import { questionStore, reply, reject } from "../../stores/question.js";

const current = computed(() => questionStore.queue[0] || null);

const freeText = ref("");

// Clear the box when the queue advances, so an answer typed for one question
// never leaks into the next.
watch(current, () => {
  freeText.value = "";
});

function answer(option) {
  if (!current.value) return;
  reply(current.value.id, option.id, null);
}

function answerFreeText() {
  if (!current.value || !freeText.value.trim()) return;
  reply(current.value.id, null, freeText.value.trim());
}

function rejectCurrent() {
  if (!current.value) return;
  reject(current.value.id);
}
</script>

<template>
  <div v-if="current" class="connect-backdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Question</span>
      </div>

      <p v-if="current.error" class="connect-error">{{ current.error }}</p>

      <p class="question-text">{{ current.question }}</p>

      <ul v-if="current.options.length" class="question-options">
        <li v-for="opt in current.options" :key="opt.id">
          <button type="button" :disabled="current.busy" @click="answer(opt)">
            <span class="question-option-label">{{ opt.label }}</span>
            <span v-if="opt.description" class="question-option-desc">{{ opt.description }}</span>
          </button>
        </li>
      </ul>

      <form v-else class="question-freetext" @submit.prevent="answerFreeText">
        <input
          v-model="freeText"
          placeholder="Your answer"
          autocomplete="off"
          autofocus
          :disabled="current.busy"
        />
        <button type="submit" :disabled="current.busy || !freeText.trim()">Answer</button>
      </form>

      <div class="connect-actions">
        <button type="button" class="connect-secondary" :disabled="current.busy" @click="rejectCurrent">
          Skip
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.question-text {
  margin: 6px 0 10px;
  white-space: pre-wrap;
}

.question-options {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
}

.question-options button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.question-options button:hover:not(:disabled) {
  border-color: var(--accent);
}

.question-option-desc {
  color: var(--dim);
  font-size: 12px;
}

.question-freetext {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.question-freetext input {
  flex: 1;
}
</style>

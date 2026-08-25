<script setup>
// The question gate. `question.v2.asked` is a *batch*: `{questions: [...]}`,
// answered in one reply whose `answers[i]` holds the labels chosen for
// `questions[i]`. Options carry no id, so a label is the identifier — see
// docs/opencode-api.md.
//
// The batch is stepped through one question per screen. The desktop stacks them
// in a tall dialog; a phone has no room, and one decision at a time is the
// better shape anyway.
import { computed, ref, watch } from "vue";
import { reject, reply } from "../../stores/question.js";

const props = defineProps({ ask: { type: Object, required: true } });

const index = ref(0);
const answers = ref([]);
const custom = ref("");

// A new batch resets the walk. Without this, a second ask arriving while the
// first is still on screen would inherit the previous one's cursor and answers.
watch(
  () => props.ask.id,
  () => {
    index.value = 0;
    answers.value = props.ask.questions.map(() => []);
    custom.value = "";
  },
  { immediate: true }
);

const q = computed(() => props.ask.questions[index.value] || null);
const chosen = computed(() => answers.value[index.value] || []);
const isLast = computed(() => index.value >= props.ask.questions.length - 1);
const canAdvance = computed(() => chosen.value.length > 0 || custom.value.trim().length > 0);

function pick(label) {
  const current = [...chosen.value];
  if (q.value.multiple) {
    const at = current.indexOf(label);
    at === -1 ? current.push(label) : current.splice(at, 1);
  } else {
    current.splice(0, current.length, label);
  }
  answers.value[index.value] = current;
  // A single-choice question is answered by the tap itself — making the user
  // then hit "Next" is a wasted step.
  if (!q.value.multiple && !q.value.custom) advance();
}

function advance() {
  const typed = custom.value.trim();
  if (typed) answers.value[index.value] = [...chosen.value, typed];
  custom.value = "";
  if (isLast.value) reply(props.ask.id, answers.value);
  else index.value += 1;
}
</script>

<template>
  <div class="backdrop">
    <div class="sheet">
      <p v-if="ask.questions.length > 1" class="step">
        {{ index + 1 }} of {{ ask.questions.length }}
      </p>
      <h2 v-if="q.header">{{ q.header }}</h2>
      <p class="question">{{ q.question }}</p>

      <div class="options">
        <button
          v-for="opt in q.options"
          :key="opt.label"
          class="option"
          :class="{ on: chosen.includes(opt.label) }"
          @click="pick(opt.label)"
        >
          <span class="label">{{ opt.label }}</span>
          <span v-if="opt.description" class="desc">{{ opt.description }}</span>
        </button>
      </div>

      <input
        v-if="q.custom"
        v-model="custom"
        class="custom"
        placeholder="Or type an answer…"
        autocapitalize="sentences"
      />

      <p v-if="ask.error" class="err">{{ ask.error }}</p>

      <div class="buttons">
        <button
          v-if="q.multiple || q.custom"
          class="next"
          :disabled="!canAdvance || ask.busy"
          @click="advance"
        >
          {{ isLast ? "Send" : "Next" }}
        </button>
        <button class="cancel" :disabled="ask.busy" @click="reject(ask.id)">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  background: rgb(0 0 0 / 0.55);
}

.sheet {
  width: 100%;
  max-height: 85%;
  overflow-y: auto;
  padding: 22px 20px calc(env(safe-area-inset-bottom, 0px) + 20px);
  border-radius: 20px 20px 0 0;
  background: var(--bg-raised);
}

.step {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--fg-dim);
}

h2 {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.question {
  margin: 0 0 16px;
  font-size: 17px;
  line-height: 1.45;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
  color: var(--fg);
  text-align: left;
}

.option.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.label {
  font-size: 15px;
  font-weight: 600;
}

.desc {
  font-size: 13px;
  color: var(--fg-dim);
  line-height: 1.45;
}

.custom {
  width: 100%;
  font-size: 16px;
  padding: 13px 14px;
  margin-bottom: 14px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--fg);
}

.custom:focus {
  outline: none;
  border-color: var(--accent);
}

.err {
  margin: 0 0 12px;
  color: var(--bad);
  font-size: 13px;
}

.buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.next {
  padding: 15px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 16px;
  font-weight: 600;
}

.next:disabled {
  opacity: 0.45;
}

.cancel {
  padding: 13px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 15px;
}
</style>

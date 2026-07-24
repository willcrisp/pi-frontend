<!--
  Composer component for OpenCode V2: handles text input, model/agent select
  (models grouped by provider), D20 die fidget toy, send prompt & abort
  actions. The textarea placeholder cycles a random sci-fi/fantasy quote
  per mount (SCI_FI_QUOTES) rather than a static hint.
-->
<script setup>
import { computed, nextTick, ref } from "vue";
import {
  opencodeStore as store,
  sendPrompt,
  abortSession,
  setModel,
  setAgent,
} from "../../stores/opencode.js";
import D20Die from "./D20Die.vue";

const input = ref("");
const textareaEl = ref(null);

const sending = computed(() => store.isStreaming);

const SCI_FI_QUOTES = [
  "I must not fear. Fear is the mind-killer. — Dune",
  "It is by will alone I set my mind in motion. — Dune",
  "The ships hung in the sky in much the same way that bricks don't. — The Hitchhiker's Guide to the Galaxy",
  "Space is big. You just won't believe how vastly, hugely, mind-bogglingly big it is. — The Hitchhiker's Guide to the Galaxy",
  "Don't Panic. — The Hitchhiker's Guide to the Galaxy",
  "The sky above the port was the color of television, tuned to a dead channel. — Neuromancer",
  "So it goes. — Slaughterhouse-Five",
  "All this happened, more or less. — Slaughterhouse-Five",
  "Violence is the last refuge of the incompetent. — Foundation",
  "The enemy's gate is down. — Ender's Game",
  "That is not dead which can eternal lie. — At the Mountains of Madness",
  "Life before death. Strength before weakness. Journey before destination. — The Way of Kings",
  "The most important step a man can take is the next one. — Oathbringer",
  "Journey before destination. — Words of Radiance",
  "I've a hankering to be a hero. — Mistborn: The Final Empire",
  "There's always another secret. — Mistborn: The Well of Ascension",
  "Not all those who wander are lost. — The Fellowship of the Ring",
  "All we have to decide is what to do with the time that is given us. — The Fellowship of the Ring",
  "It's a dangerous business, going out your door. — The Hobbit",
  "A wizard is never late. — The Fellowship of the Ring",
  "The wheel weaves as the wheel wills. — The Wheel of Time",
  "It's like the people who believe they'll be happy if they go and live somewhere else. — The Colour of Magic",
  "Words are pale shadows of forgotten names. — The Name of the Wind",
  "It's the questions we can't answer that teach us the most. — The Wise Man's Fear",
  "When you play the game of thrones, you win or you die. — A Game of Thrones",
  "A reader lives a thousand lives before he dies. — A Dance with Dragons",
  "To light a candle is to cast a shadow. — A Wizard of Earthsea",
  "The unread story is not a story. — The Language of the Night",
];

function randomPlaceholder() {
  const i = Math.floor(Math.random() * SCI_FI_QUOTES.length);
  return SCI_FI_QUOTES[i];
}

const composerPlaceholder = ref(randomPlaceholder());

function submit() {
  const text = input.value.trim();
  if (!text || store.isStreaming) return;

  sendPrompt(text);
  input.value = "";
  nextTick(autosize);
}

function onKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function autosize() {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

const selectedModelKey = computed(() =>
  store.selectedModel ? `${store.selectedModel.providerID}:${store.selectedModel.modelID}` : ""
);

const modelsByProvider = computed(() => {
  const groups = new Map();
  for (const m of store.availableModels) {
    const key = m.providerID || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()];
});

function onModelChange(e) {
  const value = e.target.value;
  if (!value) return;
  const sep = value.indexOf(":");
  setModel({ providerID: value.slice(0, sep), modelID: value.slice(sep + 1) });
}

function onAgentChange(e) {
  setAgent(e.target.value);
}
</script>

<template>
  <footer>
    <div class="composer">
      <D20Die />
      <div class="composer-field">
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          :placeholder="composerPlaceholder"
          title="Enter to send, Shift+Enter for newline"
          @keydown="onKeydown"
          @input="autosize"
        ></textarea>

        <div class="composer-actions">
          <button
            v-if="store.isStreaming"
            class="composer-icon-btn stop"
            title="Stop"
            @click="abortSession"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            v-else
            class="composer-icon-btn send"
            :disabled="!input.trim() || !store.activeSessionId"
            title="Send prompt"
            @click="submit"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M14.7 1.3 7.3 8.7M14.7 1.3 10 14.7 7.3 8.7 1.3 6 14.7 1.3Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="controls">
      <select
        v-if="store.availableModels.length"
        class="model-select"
        :value="selectedModelKey"
        title="Model"
        @change="onModelChange"
      >
        <optgroup
          v-for="[provider, models] in modelsByProvider"
          :key="provider"
          :label="provider"
        >
          <option
            v-for="m in models"
            :key="`${m.providerID}:${m.modelID}`"
            :value="`${m.providerID}:${m.modelID}`"
          >
            {{ m.label }}
          </option>
        </optgroup>
      </select>

      <select
        v-if="store.availableAgents.length"
        class="thinking-select"
        :value="store.selectedAgent"
        title="Agent"
        @change="onAgentChange"
      >
        <option v-for="a in store.availableAgents" :key="a.name" :value="a.name" :title="a.description">
          {{ a.name }}
        </option>
      </select>
    </div>
  </footer>
</template>

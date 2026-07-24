<!--
  Composer component for OpenCode V2: handles text input, agent/model/reasoning
  selects (agent first, models grouped by provider, reasoning options from the
  selected model's variants), D20 die fidget toy, send prompt & abort actions.
  Ctrl/Cmd+ArrowUp/Down steps the reasoning variant. The textarea placeholder
  cycles a random sci-fi/fantasy quote per mount (SCI_FI_QUOTES).
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  opencodeStore as store,
  sendPrompt,
  abortSession,
  setModel,
  setAgent,
  setThinkingLevel,
  runCommand,
} from "../../stores/opencode.js";
import { startNewChat, activeSessionDirectory } from "../../stores/projects.js";
import { hiddenModels, modelKey } from "../../stores/modelfilter.js";
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

  // "/name args" for a known command runs as a slash command; anything else
  // (including unknown /words) goes out as a normal prompt.
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const known = m && allCommands.value.find((c) => c.name === m[1]);
  if (known && known.source === "builtin") {
    runBuiltinCommand(known.name);
  } else if (known) {
    runCommand(m[1], (m[2] || "").trim());
  } else {
    sendPrompt(text);
  }
  input.value = "";
  nextTick(autosize);
}

function onKeydown(e) {
  if (slashOpen.value) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = slashMatches.value.length;
      slashIndex.value =
        e.key === "ArrowDown" ? (slashIndex.value + 1) % n : (slashIndex.value - 1 + n) % n;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseSlashCommand(slashMatches.value[slashIndex.value]);
      return;
    }
    if (e.key === "Escape") {
      input.value = "";
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

// Slash-command autocomplete: server commands + skills (both from opencode.js)
// plus local builtins, matched while the composer holds just "/query".
const BUILTIN_SLASH_COMMANDS = [
  { name: "new", description: "new session in this project" },
];

const allCommands = computed(() => {
  const dynamic = store.commands.map((c) => ({
    name: c.name,
    description: c.description || "",
    source: "command",
  }));
  const skills = store.skills.map((s) => ({
    name: s.name || s.id,
    description: s.description || "",
    source: "skill",
  }));
  const builtin = BUILTIN_SLASH_COMMANDS.map((c) => ({ ...c, source: "builtin" }));
  return [...dynamic, ...skills, ...builtin];
});

const slashMatches = computed(() => {
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m) return [];
  const query = m[1].toLowerCase();
  return allCommands.value.filter((c) => c.name && c.name.toLowerCase().startsWith(query));
});

const slashOpen = computed(() => slashMatches.value.length > 0);
const slashIndex = ref(0);

watch(slashMatches, () => {
  slashIndex.value = 0;
});

function chooseSlashCommand(cmd) {
  if (!cmd) return;
  if (cmd.source === "builtin") {
    input.value = "";
    runBuiltinCommand(cmd.name);
    return;
  }
  input.value = `/${cmd.name} `;
  nextTick(() => {
    textareaEl.value?.focus();
    autosize();
  });
}

// Builtins run against the harness itself instead of going to the server.
function runBuiltinCommand(name) {
  if (name === "new") {
    startNewChat(activeSessionDirectory() || undefined).catch(() => {});
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

// UI-only model filter (state shared with the header's ModelFilterPopover):
// hidden models are dropped from the picker, but a hidden model that is
// currently selected stays visible so the select never shows a value that
// isn't in its option list.
const visibleModels = computed(() =>
  store.availableModels.filter(
    (m) => !hiddenModels.value.has(modelKey(m)) || modelKey(m) === selectedModelKey.value
  )
);

function groupByProvider(models) {
  const groups = new Map();
  for (const m of models) {
    const key = m.providerID || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()];
}

const modelsByProvider = computed(() => groupByProvider(visibleModels.value));

function onModelChange(e) {
  const value = e.target.value;
  if (!value) return;
  const sep = value.indexOf(":");
  setModel({ providerID: value.slice(0, sep), modelID: value.slice(sep + 1) });
}

function onAgentChange(e) {
  setAgent(e.target.value);
}

// Reasoning-effort variants come from the selected model's Model.Info.variants
// (empty on models — or servers — without them; the select is hidden then).
const thinkingLevels = computed(() => {
  const m = store.selectedModel;
  const info = m
    ? store.availableModels.find((x) => x.providerID === m.providerID && x.modelID === m.modelID)
    : null;
  return info ? info.variants : [];
});

// Desaturated pastel gradient, cool blue (low effort) to warm red (max effort),
// tuned light enough to read on the dark theme. Variant names not in the map
// get a color from the same gradient by their position in the model's list,
// so any server-provided naming still reads cool-to-warm.
const THINKING_COLORS = {
  off: "hsl(215 38% 72%)",
  minimal: "hsl(190 36% 68%)",
  low: "hsl(160 34% 65%)",
  medium: "hsl(110 32% 64%)",
  high: "hsl(70 38% 64%)",
  xhigh: "hsl(35 42% 66%)",
  max: "hsl(5 46% 70%)",
};

function thinkingColor(level) {
  if (!level) return "inherit";
  if (THINKING_COLORS[level]) return THINKING_COLORS[level];
  const levels = thinkingLevels.value;
  const i = levels.indexOf(level);
  if (i < 0) return "inherit";
  const t = levels.length > 1 ? i / (levels.length - 1) : 0;
  return `hsl(${Math.round(215 - t * 210)} 38% 68%)`;
}

function onThinkingChange(e) {
  setThinkingLevel(e.target.value);
}

// Ctrl/Cmd+ArrowUp/Down steps through the current model's variants
// ("" default sits below the first named variant).
function onThinkingShortcut(e) {
  if (!(e.ctrlKey || e.metaKey) || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
  const levels = ["", ...thinkingLevels.value];
  if (levels.length <= 1) return;

  const current = levels.indexOf(store.thinkingLevel || "");
  const index = current < 0 ? 0 : current;
  const next = e.key === "ArrowUp" ? index + 1 : index - 1;
  if (next < 0 || next >= levels.length) return;

  e.preventDefault();
  setThinkingLevel(levels[next]);
}

onMounted(() => window.addEventListener("keydown", onThinkingShortcut));
onBeforeUnmount(() => window.removeEventListener("keydown", onThinkingShortcut));
</script>

<template>
  <footer>
    <ul v-if="slashOpen" class="slash-menu">
      <li
        v-for="(cmd, i) in slashMatches"
        :key="`${cmd.source}:${cmd.name}`"
        :class="{ active: i === slashIndex }"
        @mousedown.prevent="chooseSlashCommand(cmd)"
        @mouseenter="slashIndex = i"
      >
        <span class="slash-name">/{{ cmd.name }}</span>
        <span class="slash-desc">{{ cmd.source === "skill" ? `skill · ${cmd.description}` : cmd.description }}</span>
      </li>
    </ul>
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
        v-if="store.availableAgents.length"
        class="agent-select"
        :value="store.selectedAgent"
        title="Agent"
        @change="onAgentChange"
      >
        <option v-for="a in store.availableAgents" :key="a.id || a.name" :value="a.id || a.name" :title="a.description">
          {{ a.name }}
        </option>
      </select>

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
        v-if="thinkingLevels.length"
        class="thinking-select"
        :value="store.thinkingLevel || ''"
        title="Reasoning effort (Ctrl/Cmd+↑/↓)"
        :style="{ color: thinkingColor(store.thinkingLevel) }"
        @change="onThinkingChange"
      >
        <option value="">default</option>
        <option
          v-for="level in thinkingLevels"
          :key="level"
          :value="level"
          :style="{ color: thinkingColor(level) }"
        >
          {{ level }}
        </option>
      </select>
    </div>
  </footer>
</template>

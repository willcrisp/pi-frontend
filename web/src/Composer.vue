<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  BUILTIN_SLASH_COMMANDS,
  THINKING_LEVELS,
  abort,
  compactSession,
  copyLastAssistantText,
  exportSession,
  sendPrompt,
  setModel,
  setThinkingLevel,
  store,
} from "./pi.js";
import { openRenameDialog } from "./renameDialog.js";
import D20Die from "./D20Die.vue";
import GitBranchSelect from "./GitBranchSelect.vue";

const input = ref("");
const textareaEl = ref(null);
const pendingImages = ref([]); // [{ mimeType, data, previewUrl }]
const toast = ref(null);
let toastTimer = null;

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

// A fork hands back the prompt it branched from (see forkFrom in pi.js) so it
// can be edited and re-sent down the new branch.
watch(
  () => store.composerDraft,
  (text) => {
    if (!text) return;
    input.value = text;
    store.composerDraft = "";
    nextTick(() => {
      textareaEl.value?.focus();
      autosize();
    });
  }
);

function showToast(message) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 3000);
}

// Slash-command autocomplete: all commands are "/name" typed at the very start
// of the composer, mirroring pi's own slash-command UX.
const allCommands = computed(() => {
  const dynamic = store.commands.map((c) => ({
    name: c.name,
    description: c.description,
    source: c.source,
  }));
  const builtin = BUILTIN_SLASH_COMMANDS.map((c) => ({ ...c, source: "builtin" }));
  return [...dynamic, ...builtin];
});

const slashMatches = computed(() => {
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m) return [];
  const query = m[1].toLowerCase();
  return allCommands.value.filter((c) => c.name.toLowerCase().startsWith(query));
});

const slashOpen = computed(() => slashMatches.value.length > 0);
const slashIndex = ref(0);

watch(slashMatches, () => {
  slashIndex.value = 0;
});

function chooseSlashCommand(cmd) {
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

// Builtins run immediately instead of being sent to pi as a prompt — pi's RPC mode
// doesn't parse these as text (see BUILTIN_SLASH_COMMANDS in pi.js), so each one is
// wired here to the RPC command it maps to.
async function runBuiltinCommand(name) {
  try {
    if (name === "name") {
      openRenameDialog();
    } else if (name === "export") {
      const { path } = await exportSession();
      showToast(`Exported to ${path}`);
    } else if (name === "copy") {
      const text = await copyLastAssistantText();
      showToast(text ? "Copied last reply to clipboard" : "No assistant reply to copy");
    } else if (name === "compact") {
      await compactSession();
      showToast("Session compacted");
    }
  } catch (e) {
    showToast(`/${name} failed: ${e.message}`);
  }
}

const modelKey = computed(() =>
  store.model ? `${store.model.provider}::${store.model.id}` : ""
);

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);

const modelsByProvider = computed(() => {
  const groups = new Map();
  for (const m of store.availableModels) {
    const key = m.provider || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()];
});

const thinkingDisabled = computed(() => !store.model?.reasoning);

// Desaturated pastel gradient, cool blue (low effort) to warm red (max effort),
// tuned light enough to read on the dark theme.
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
  return THINKING_COLORS[level] || "inherit";
}

function onModelChange(e) {
  const key = e.target.value;
  const model = store.availableModels.find(
    (m) => `${m.provider}::${m.id}` === key
  );
  if (model) setModel(model);
}

function onThinkingChange(e) {
  setThinkingLevel(e.target.value);
}

function submit() {
  const text = input.value.trim();
  if (!text && !pendingImages.value.length) return;
  sendPrompt(text, pendingImages.value);
  input.value = "";
  pendingImages.value = [];
  nextTick(autosize);
}

function onKeydown(e) {
  if (slashOpen.value) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashIndex.value = (slashIndex.value + 1) % slashMatches.value.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex.value = (slashIndex.value - 1 + slashMatches.value.length) % slashMatches.value.length;
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      chooseSlashCommand(slashMatches.value[slashIndex.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function addImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const match = /^data:(.+);base64,(.*)$/s.exec(reader.result);
    if (!match) return;
    const [, mimeType, data] = match;
    pendingImages.value.push({ mimeType, data, previewUrl: reader.result });
  };
  reader.readAsDataURL(file);
}

function onPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  let sawImage = false;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      sawImage = true;
      const file = item.getAsFile();
      if (file) addImageFile(file);
    }
  }
  if (sawImage) e.preventDefault();
}

function removeImage(i) {
  pendingImages.value.splice(i, 1);
}

function autosize() {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
</script>

<template>
  <footer>
    <div v-if="toast" class="composer-toast">{{ toast }}</div>
    <div v-if="pendingImages.length" class="pending-images">
      <div v-for="(img, i) in pendingImages" :key="i" class="pending-image">
        <img :src="img.previewUrl" alt="" />
        <button class="remove-image" title="Remove" @click="removeImage(i)">×</button>
      </div>
    </div>
    <ul v-if="slashOpen" class="slash-menu">
      <li
        v-for="(cmd, i) in slashMatches"
        :key="cmd.name"
        :class="{ active: i === slashIndex }"
        @mousedown.prevent="chooseSlashCommand(cmd)"
        @mouseenter="slashIndex = i"
      >
        <span class="slash-name">/{{ cmd.name }}</span>
        <span class="slash-desc">{{ cmd.description }}</span>
      </li>
    </ul>
    <div class="composer">
      <D20Die />
      <div class="composer-field">
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          :placeholder="`${composerPlaceholder}`"
          title="Enter to send, Shift+Enter for a new line"
          @keydown="onKeydown"
          @paste="onPaste"
          @input="autosize"
        ></textarea>
        <div class="composer-actions">
          <button
            v-if="store.streaming"
            class="composer-icon-btn stop"
            aria-label="Stop"
            title="Stop"
            @click="abort"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            class="composer-icon-btn send"
            :aria-label="store.streaming ? 'Steer' : 'Send'"
            :title="store.streaming ? 'Steer the agent with this message' : 'Send'"
            :disabled="!input.trim() && !pendingImages.length"
            @click="submit"
          >
            <svg v-if="store.streaming" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <line x1="4" y1="2" x2="4" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.2" />
              <circle cx="4" cy="12" r="2" stroke="currentColor" stroke-width="1.2" />
              <path d="M12 6a6 6 0 0 1-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none">
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
      <GitBranchSelect />
      <select
        class="model-select"
        :value="modelKey"
        title="Model"
        @change="onModelChange"
      >
        <option v-if="!store.availableModels.length" :value="modelKey">
          {{ modelLabel }}
        </option>
        <optgroup
          v-for="[provider, models] in modelsByProvider"
          :key="provider"
          :label="provider"
        >
          <option
            v-for="m in models"
            :key="`${m.provider}::${m.id}`"
            :value="`${m.provider}::${m.id}`"
          >
            {{ m.name || m.id }}
          </option>
        </optgroup>
      </select>
      <span
        class="level-dot"
        :title="thinkingDisabled ? 'Reasoning effort unavailable for this model' : `Reasoning effort: ${store.thinkingLevel}`"
        :style="{ background: thinkingDisabled ? 'var(--dim)' : thinkingColor(store.thinkingLevel) }"
      ></span>
      <select
        class="thinking-select"
        :value="store.thinkingLevel || ''"
        title="Reasoning effort"
        :disabled="thinkingDisabled"
        :style="{ color: thinkingDisabled ? '' : thinkingColor(store.thinkingLevel) }"
        @change="onThinkingChange"
      >
        <option
          v-for="level in THINKING_LEVELS"
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

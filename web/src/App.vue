<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  BUILTIN_SLASH_COMMANDS,
  THINKING_LEVELS,
  abort,
  sendPrompt,
  setModel,
  setThinkingLevel,
  store,
} from "./pi.js";
import { projectsStore } from "./projects.js";
import MessageView from "./MessageView.vue";
import Sidebar from "./Sidebar.vue";
import UsagePopover from "./UsagePopover.vue";

const input = ref("");
const textareaEl = ref(null);
const mainEl = ref(null);
const pendingImages = ref([]); // [{ mimeType, data, previewUrl }]

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
  input.value = `/${cmd.name} `;
  nextTick(() => {
    textareaEl.value?.focus();
    autosize();
  });
}

const visible = computed(() =>
  store.messages.filter((m) => m.role === "user" || m.role === "assistant")
);

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);

const modelKey = computed(() =>
  store.model ? `${store.model.provider}::${store.model.id}` : ""
);

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

// Follow the stream unless the user has scrolled up.
watch(
  () => JSON.stringify(store.messages.at(-1) ?? null),
  async () => {
    const el = mainEl.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      await nextTick();
      el.scrollTop = el.scrollHeight;
    }
  }
);
</script>

<template>
  <Sidebar />

  <div v-if="!projectsStore.currentProjectId" class="chat-panel chat-empty">
    <p>select or add a project to start chatting</p>
  </div>

  <div v-else class="chat-panel">
    <header>
      <span
        class="dot"
        :class="{ connected: store.connected, streaming: store.streaming }"
      ></span>
      <span class="wordmark">pi</span>
      <span>{{ modelLabel }}</span>
      <span v-if="store.sessionName">· {{ store.sessionName }}</span>
      <UsagePopover class="header-usage" />
    </header>

    <main ref="mainEl">
      <div class="messages">
        <MessageView v-for="(m, i) in visible" :key="i" :message="m" />
      </div>
    </main>

    <footer>
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
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          placeholder="Message pi… (paste an image to attach it)"
          @keydown="onKeydown"
          @paste="onPaste"
          @input="autosize"
        ></textarea>
        <button v-if="store.streaming" class="stop" @click="abort">stop</button>
        <button v-else @click="submit">send</button>
      </div>
      <div class="controls">
        <select
          class="model-select"
          :value="modelKey"
          title="Model"
          @change="onModelChange"
        >
          <option v-if="!store.availableModels.length" :value="modelKey">
            {{ modelLabel }}
          </option>
          <option
            v-for="m in store.availableModels"
            :key="`${m.provider}::${m.id}`"
            :value="`${m.provider}::${m.id}`"
          >
            {{ m.name || m.id }}
          </option>
        </select>
        <span
          class="level-dot"
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
  </div>
</template>

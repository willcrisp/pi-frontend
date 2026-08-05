<!--
  Ctrl/Cmd+K command palette: fuzzy jump between OpenCode V2 sessions, or open
  a file from the active session's project into the preview pane.
  Always mounted from App.vue; owns its own global hotkey listener.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  activeSessionDirectory,
  openSession,
  rootSessions,
  startNewChat,
} from "../../stores/projects.js";
import { filesFor, refreshFiles } from "../../stores/filesearch.js";
import { openPreview } from "../../stores/filepreview.js";
import { fuzzyScore } from "../../lib/fuzzy.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const open = ref(false);
const query = ref("");
const index = ref(0);
const inputEl = ref(null);

function openPalette() {
  open.value = true;
  query.value = "";
  index.value = 0;
  const dir = activeSessionDirectory();
  if (dir) refreshFiles(dir); // background refresh; cached list shows immediately
  nextTick(() => inputEl.value?.focus());
}

function close() {
  open.value = false;
}

// Ctrl/Cmd+K only. Escape goes through the shared stack (`open` is passed, since
// this component stays mounted while closed to keep listening for the hotkey),
// so a palette opened over another dialog closes just the palette.
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    open.value ? close() : openPalette();
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKey));

const { onBackdrop } = useDialogEscape(close, { open });

const items = computed(() => {
  const out = [];
  // Root sessions only, matching the sidebar: a sub-agent's session is reached
  // by drilling into its card, not picked from a flat list of chats.
  for (const s of rootSessions()) {
    out.push({
      kind: "session",
      id: s.id,
      label: s.title || "(untitled)",
      run: () => openSession(s.id),
    });
  }
  return out;
});

const fileItems = computed(() => {
  const dir = activeSessionDirectory();
  if (!dir) return [];
  // Opening the preview pane is the useful thing to do with a file here.
  // Copying the path to the clipboard (what this used to do) gave no feedback
  // at all, so picking a file looked like it had done nothing.
  return filesFor(dir).files.map((path) => ({
    kind: "file",
    id: `file:${path}`,
    label: path,
    run: () => openPreview(path),
  }));
});

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value.slice(0, 20);
  const scored = [];
  for (const it of items.value.concat(fileItems.value)) {
    const score = fuzzyScore(q, it.label.toLowerCase());
    if (score !== null) scored.push({ it, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it)
    .slice(0, 20);
});

watch(matches, () => {
  index.value = 0;
});

function choose(it) {
  it.run();
  close();
}

function onInputKeydown(e) {
  if (!matches.value.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    index.value = (index.value + 1) % matches.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    index.value = (index.value - 1 + matches.value.length) % matches.value.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    choose(matches.value[index.value]);
  }
}
</script>

<template>
  <div v-if="open" class="palette-backdrop" @mousedown="onBackdrop">
    <div class="palette">
      <input
        ref="inputEl"
        v-model="query"
        class="palette-input"
        placeholder="Jump to a session, or open a file…"
        spellcheck="false"
        @keydown="onInputKeydown"
      />
      <ul v-if="matches.length" class="palette-list">
        <li
          v-for="(it, i) in matches"
          :key="it.id"
          :class="{ active: i === index }"
          @mousedown.prevent="choose(it)"
          @mouseenter="index = i"
        >
          <span class="palette-kind" :class="it.kind">{{ it.kind }}</span>
          <span class="palette-label">{{ it.label }}</span>
        </li>
      </ul>
      <div v-else class="palette-empty">no matches</div>
    </div>
  </div>
</template>

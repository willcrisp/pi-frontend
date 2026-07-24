<!--
  Ctrl/Cmd+K command palette: fuzzy jump between OpenCode V2 sessions.
  Always mounted from App.vue; owns its own global hotkey listener.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { activeSessionDirectory, openSession, projectsStore, startNewChat } from "../../stores/projects.js";
import { filesFor, refreshFiles } from "../../stores/filesearch.js";

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

function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    open.value ? close() : openPalette();
  } else if (open.value && e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKey));

// Subsequence fuzzy match; higher score = better.
function fuzzyScore(q, s) {
  let score = 0;
  let si = 0;
  let prevHit = -2;
  for (const ch of q) {
    const hit = s.indexOf(ch, si);
    if (hit === -1) return null;
    score += 1;
    if (hit === prevHit + 1) score += 2;
    if (hit === 0 || " /\\-_.:".includes(s[hit - 1])) score += 3;
    prevHit = hit;
    si = hit + 1;
  }
  return score - s.length / 100;
}

const items = computed(() => {
  const out = [];
  for (const s of projectsStore.sessions) {
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
  return filesFor(dir).files.map((path) => ({
    kind: "file",
    id: `file:${path}`,
    label: path,
    run: () => navigator.clipboard?.writeText(path),
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

function onBackdrop(e) {
  if (e.target === e.currentTarget) close();
}
</script>

<template>
  <div v-if="open" class="palette-backdrop" @mousedown="onBackdrop">
    <div class="palette">
      <input
        ref="inputEl"
        v-model="query"
        class="palette-input"
        placeholder="Jump to a session…"
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

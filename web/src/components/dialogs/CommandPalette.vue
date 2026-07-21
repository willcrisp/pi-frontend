<!--
  Ctrl/Cmd+K command palette: fuzzy jump between projects and the current
  project's (non-archived) chats, subsequence-matched and scored client-side.
  Always mounted from App.vue; owns its own global hotkey listener.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { isArchived, openSession, projectsStore, selectProject } from "../../stores/projects.js";

const open = ref(false);
const query = ref("");
const index = ref(0);
const inputEl = ref(null);

function openPalette() {
  open.value = true;
  query.value = "";
  index.value = 0;
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

// Subsequence fuzzy match; higher score = better. Consecutive matches and
// matches at word starts score extra; null = no match.
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
  return score - s.length / 100; // prefer shorter targets on ties
}

const currentProjectName = computed(
  () => projectsStore.projects.find((p) => p.id === projectsStore.currentProjectId)?.name || ""
);

const items = computed(() => {
  const out = [];
  for (const p of projectsStore.projects) {
    out.push({
      kind: "project",
      label: p.name,
      hint: p.path,
      active: p.id === projectsStore.currentProjectId,
      run: () => selectProject(p.id),
    });
  }
  for (const s of projectsStore.sessions) {
    if (isArchived(s.path)) continue;
    out.push({
      kind: "chat",
      label: s.title || "(untitled)",
      hint: currentProjectName.value,
      run: () => openSession(s.path),
    });
  }
  return out;
});

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value.slice(0, 20);
  return items.value
    .map((it) => ({ it, score: fuzzyScore(q, `${it.label} ${it.hint || ""}`.toLowerCase()) }))
    .filter((x) => x.score !== null)
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
        placeholder="Jump to a project or chat…"
        spellcheck="false"
        @keydown="onInputKeydown"
      />
      <ul v-if="matches.length" class="palette-list">
        <li
          v-for="(it, i) in matches"
          :key="`${it.kind}:${it.label}:${i}`"
          :class="{ active: i === index }"
          @mousedown.prevent="choose(it)"
          @mouseenter="index = i"
        >
          <span class="palette-kind" :class="it.kind">{{ it.kind }}</span>
          <span class="palette-label">
            {{ it.label }}<span v-if="it.active" class="palette-current"> · current</span>
          </span>
          <span class="palette-hint">{{ it.hint }}</span>
        </li>
      </ul>
      <div v-else class="palette-empty">no matches</div>
    </div>
  </div>
</template>

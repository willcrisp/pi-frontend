<!--
  Ctrl/Cmd+K command palette: fuzzy jump between projects and the current
  project's (non-archived) chats, subsequence-matched and scored client-side.
  Once the query reaches 3+ characters it also runs a debounced cross-chat
  content search of the current project (stores/search.js) and appends any
  matches below the fuzzy results as a third `message` kind, deduplicated
  against chats already shown as a title match. Always mounted from App.vue;
  owns its own global hotkey listener.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { isArchived, openSession, projectsStore, selectProject } from "../../stores/projects.js";
import { resetSearch, searchMessages, searchStore } from "../../stores/search.js";

const open = ref(false);
const query = ref("");
const index = ref(0);
const inputEl = ref(null);

// Content search runs debounced (~200ms) rather than on every keystroke, and
// is superseded automatically (stores/search.js drops stale responses by
// sequence number) if the query keeps changing while a request is in flight.
const SEARCH_MIN_LEN = 3;
const SEARCH_DEBOUNCE_MS = 200;
let searchTimer = null;

function scheduleSearch(q) {
  if (searchTimer) clearTimeout(searchTimer);
  const trimmed = q.trim();
  if (trimmed.length < SEARCH_MIN_LEN) {
    resetSearch();
    return;
  }
  searchTimer = setTimeout(() => {
    searchMessages(projectsStore.currentProjectId, trimmed);
  }, SEARCH_DEBOUNCE_MS);
}

watch(query, scheduleSearch);

function openPalette() {
  open.value = true;
  query.value = "";
  index.value = 0;
  resetSearch();
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
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKey);
  if (searchTimer) clearTimeout(searchTimer);
});

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
      path: s.path, // lets the appended message-search results dedupe against this
      run: () => openSession(s.path),
    });
  }
  return out;
});

// Content-search results to append below the fuzzy matches, once the query
// is long enough (see scheduleSearch/SEARCH_MIN_LEN above). Deduplicated
// against chats already present as a title match — a chat already in view
// above doesn't need to reappear just because it also contains the text.
const MAX_MESSAGE_MATCHES = 8;

function messageMatches(fuzzy) {
  if (query.value.trim().length < SEARCH_MIN_LEN) return [];
  const knownPaths = new Set(fuzzy.filter((it) => it.kind === "chat").map((it) => it.path));
  return searchStore.results
    .filter((r) => !knownPaths.has(r.path))
    .slice(0, MAX_MESSAGE_MATCHES)
    .map((r) => ({
      kind: "message",
      label: r.title || "(untitled)",
      snippet: r.snippet,
      path: r.path,
      run: () => openSession(r.path),
    }));
}

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  const fuzzy = !q
    ? items.value.slice(0, 20)
    : items.value
        .map((it) => ({ it, score: fuzzyScore(q, `${it.label} ${it.hint || ""}`.toLowerCase()) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.it)
        .slice(0, 20);
  return [...fuzzy, ...messageMatches(fuzzy)];
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
          :key="it.kind === 'message' ? `message:${it.path}` : `${it.kind}:${it.label}:${i}`"
          :class="{ active: i === index, message: it.kind === 'message' }"
          @mousedown.prevent="choose(it)"
          @mouseenter="index = i"
        >
          <template v-if="it.kind === 'message'">
            <div class="palette-message-row">
              <span class="palette-kind message">chat</span>
              <span class="palette-label">{{ it.label }}</span>
            </div>
            <span class="palette-snippet">{{ it.snippet }}</span>
          </template>
          <template v-else>
            <span class="palette-kind" :class="it.kind">{{ it.kind }}</span>
            <span class="palette-label">
              {{ it.label }}<span v-if="it.active" class="palette-current"> · current</span>
            </span>
            <span class="palette-hint">{{ it.hint }}</span>
          </template>
        </li>
      </ul>
      <div v-else class="palette-empty">no matches</div>
    </div>
  </div>
</template>

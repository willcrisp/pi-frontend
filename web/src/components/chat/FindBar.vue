<!--
  Ctrl/Cmd+F find-in-transcript bar, floating over the message column (see
  MessageList.vue, which mounts this and hands it the `.messages` element to
  search). Owns its own global hotkey listener, same pattern as
  CommandPalette.vue's Ctrl/Cmd+K.

  Matches are highlighted via the CSS Custom Highlight API (`::highlight()`
  in style.css) rather than injected DOM wrapper nodes, because the message
  column contains v-html regions (rendered markdown) that Vue re-renders on
  every streaming update — wrapper nodes planted inside them would get
  clobbered or corrupted. Where the browser lacks Highlight API support, we
  still count matches and scroll to them, just without the color.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { store } from "../../stores/pi.js";

const props = defineProps({
  // The `.messages` element to search within (a plain DOM node, not a Vue
  // ref wrapper — template refs auto-unwrap when passed as props).
  container: { type: Object, default: null },
});

const HL_ALL = "pi-find";
const HL_CURRENT = "pi-find-current";
const supportsHighlight =
  typeof window !== "undefined" && !!window.CSS?.highlights && typeof window.Highlight === "function";

const open = ref(false);
const query = ref("");
const inputEl = ref(null);
const total = ref(0);
const currentIndex = ref(-1); // 0-based; -1 = no current match

// Range objects don't belong in Vue's reactivity (proxying them is at best
// wasted work, at worst breaks their internal DOM bookkeeping), so this is a
// plain array kept in sync with `total`/`currentIndex` by hand.
let matches = [];
let debounceTimer = null;

function clearHighlights() {
  if (!supportsHighlight) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CURRENT);
}

function isInsideClosedDetails(el, root) {
  while (el && el !== root) {
    if (el.tagName === "DETAILS" && !el.open) return true;
    el = el.parentElement;
  }
  return false;
}

// Case-insensitive substring match, one Range per hit, scoped to text nodes
// under `root`. Matches inside a collapsed <details> (a tool call the user
// hasn't expanded) aren't visible, so they're skipped rather than counted.
function collectMatches(root, q) {
  const out = [];
  if (!root || !q) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
      if (isInsideClosedDetails(parent, root)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const lower = node.textContent.toLowerCase();
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(q, from)) !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + q.length);
      out.push(range);
      from = idx + q.length;
    }
  }
  return out;
}

function applyHighlights() {
  if (!supportsHighlight) return;
  if (!matches.length) {
    clearHighlights();
    return;
  }
  CSS.highlights.set(HL_ALL, new Highlight(...matches));
  if (currentIndex.value >= 0) {
    const cur = new Highlight(matches[currentIndex.value]);
    cur.priority = 1; // win over HL_ALL where the two overlap
    CSS.highlights.set(HL_CURRENT, cur);
  } else {
    CSS.highlights.delete(HL_CURRENT);
  }
}

// preserveIndex: keep pointing at "the same" match across a re-scan (used
// when store.messages changes mid-search) rather than snapping back to the
// first match (used for a fresh query).
function runSearch(preserveIndex) {
  const q = query.value.trim().toLowerCase();
  matches = collectMatches(props.container, q);
  total.value = matches.length;
  if (!matches.length) {
    currentIndex.value = -1;
  } else if (preserveIndex && currentIndex.value >= 0) {
    currentIndex.value = Math.min(currentIndex.value, matches.length - 1);
  } else {
    currentIndex.value = 0;
  }
  applyHighlights();
}

function scrollToCurrent() {
  const range = currentIndex.value >= 0 ? matches[currentIndex.value] : null;
  // Scroll the containing element rather than the bare text node/Range —
  // Range has no scrollIntoView, and centering on the paragraph reads better
  // than centering on a mid-word point anyway.
  range?.startContainer?.parentElement?.scrollIntoView({ block: "center" });
}

function step(delta) {
  if (!matches.length) return;
  currentIndex.value = (currentIndex.value + delta + matches.length) % matches.length;
  applyHighlights();
  scrollToCurrent();
}

function openBar() {
  open.value = true;
  nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
  if (query.value) runSearch(true);
}

function closeBar() {
  open.value = false;
  query.value = "";
  matches = [];
  total.value = 0;
  currentIndex.value = -1;
  clearHighlights();
}

// A fresh query starts over from the first match; jump to it immediately so
// typing feels live, same as a browser's own find bar.
watch(query, () => {
  runSearch(false);
  if (matches.length) scrollToCurrent();
});

// Debounced so a streaming reply re-scans at most a few times a second
// instead of on every token.
const messagesSignature = computed(
  () => `${store.messages.length}:${JSON.stringify(store.messages.at(-1) ?? null)}`
);
watch(messagesSignature, () => {
  if (!open.value) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(true), 150);
});

function onInputKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeBar();
  }
}

function onGlobalKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault(); // steal it from the browser's native find
    if (open.value) {
      inputEl.value?.focus();
      inputEl.value?.select();
    } else {
      openBar();
    }
  } else if (open.value && e.key === "Escape") {
    e.preventDefault();
    closeBar();
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKey);
  clearTimeout(debounceTimer);
  clearHighlights();
});
</script>

<template>
  <div v-if="open" class="find-bar">
    <input
      ref="inputEl"
      v-model="query"
      class="find-input"
      type="text"
      placeholder="Find in chat…"
      spellcheck="false"
      @keydown="onInputKeydown"
    />
    <span class="find-count">
      <template v-if="query.trim() && total === 0">no results</template>
      <template v-else-if="total">{{ currentIndex + 1 }} / {{ total }}</template>
    </span>
    <button
      type="button"
      class="find-nav"
      title="Previous match (Shift+Enter)"
      :disabled="!total"
      @click="step(-1)"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 10.5 8 5.5l4 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      type="button"
      class="find-nav"
      title="Next match (Enter)"
      :disabled="!total"
      @click="step(1)"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 5.5 8 10.5l4-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button type="button" class="find-close" title="Close (Esc)" @click="closeBar">×</button>
  </div>
</template>

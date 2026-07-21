<script setup>
// Floating index of the prompts sent in this chat, shown faded in the gutter
// left of the message column. Clicking an entry scrolls its message into view;
// hovering reveals a fork button that branches the session at that prompt.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { forkFrom, store } from "../../stores/pi.js";

const props = defineProps({
  // The scrollable <main> the message elements live in, for scroll tracking.
  scroller: { type: Object, default: null },
});

const activeIndex = ref(-1);
const atBottom = ref(true);
const forking = ref(null);

function messageText(m) {
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

// One entry per user message, carrying its index in the rendered message list
// (for scrolling) and — paired positionally with get_fork_messages, which lists
// the same user messages in the same order — its fork point. A message sent
// optimistically this turn has no entryId yet and simply isn't forkable.
const items = computed(() => {
  const visible = store.messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  const out = [];
  let nth = 0;
  visible.forEach((m, index) => {
    if (m.role !== "user") return;
    const text = messageText(m);
    out.push({
      index,
      text: text || "(image)",
      entryId: store.forkMessages[nth]?.entryId,
    });
    nth++;
  });
  return out;
});

function scrollTo(item) {
  document
    .getElementById(`msg-${item.index}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function fork(item) {
  if (!item.entryId || forking.value) return;
  forking.value = item.entryId;
  try {
    await forkFrom(item.entryId);
  } catch (e) {
    console.warn("fork failed:", e.message);
  } finally {
    forking.value = null;
  }
}

function scrollToBottom() {
  const el = props.scroller;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}

// Highlight whichever prompt the reader is currently sitting in, and track
// whether there's anything below the fold worth jumping to.
function syncScroll() {
  const el = props.scroller;
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  let current = -1;
  for (const item of items.value) {
    const node = document.getElementById(`msg-${item.index}`);
    if (node && node.getBoundingClientRect().top - top <= 40) current = item.index;
  }
  activeIndex.value = current;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

// The scroller is a parent template ref, so it arrives as null on first render
// and is patched in afterwards — bind the listener when it actually shows up.
watch(
  () => props.scroller,
  (el, prev) => {
    prev?.removeEventListener("scroll", syncScroll);
    el?.addEventListener("scroll", syncScroll, { passive: true });
    syncScroll();
  },
  { immediate: true }
);

// New messages change both the fold position and the set of rail entries.
watch(items, () => nextTick(syncScroll));

onMounted(syncScroll);
onBeforeUnmount(() => props.scroller?.removeEventListener("scroll", syncScroll));
</script>

<template>
  <nav v-if="items.length" class="msg-rail" aria-label="Prompts in this chat">
    <ol>
      <li
        v-for="item in items"
        :key="item.index"
        :class="{ active: item.index === activeIndex }"
      >
        <button
          type="button"
          class="msg-rail-jump"
          :title="item.text"
          @click="scrollTo(item)"
        >
          {{ item.text }}
        </button>
        <button
          v-if="item.entryId"
          type="button"
          class="msg-rail-fork"
          :disabled="forking === item.entryId"
          title="Fork the chat from this message"
          @click="fork(item)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="4" cy="3" r="1.8" stroke="currentColor" stroke-width="1.2" />
            <circle cx="4" cy="13" r="1.8" stroke="currentColor" stroke-width="1.2" />
            <circle cx="12" cy="6" r="1.8" stroke="currentColor" stroke-width="1.2" />
            <path
              d="M4 4.8v6.4M4 9c0-2 1.5-3 4-3"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </li>
    </ol>
    <button
      v-if="!atBottom"
      type="button"
      class="msg-rail-bottom"
      title="Scroll to the latest message"
      @click="scrollToBottom"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.5v10M4 8.5 8 12.5l4-4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      bottom
    </button>
  </nav>
</template>

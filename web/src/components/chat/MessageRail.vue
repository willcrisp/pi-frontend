<!--
  Floating index of the prompts sent in this chat, shown faded in the gutter
  left of the message column. Clicking an entry scrolls its message into view.

  Vertically centred in the gutter, listed oldest to newest, so the newest
  prompt is the bottom entry.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";

const props = defineProps({
  scroller: { type: Object, default: null },
});

const activeIndex = ref(-1);
const atBottom = ref(true);

function messageText(m) {
  return m.text || "";
}

// `index` must be the index into store.messages, because that is what
// MessageList uses for its `msg-N` element ids that scrollTo() targets.
const items = computed(() => {
  const out = [];
  store.messages.forEach((m, index) => {
    if (m.role !== "user") return;
    out.push({ index, text: messageText(m) || "(prompt)" });
  });
  return out;
});

const listEl = ref(null);

// When the list overflows its own box the newest entries are the ones that
// fall out of view — keep them pinned instead.
function scrollRailToNewest() {
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function scrollTo(item) {
  document
    .getElementById(`msg-${item.index}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToBottom() {
  const el = props.scroller;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}

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

watch(
  () => props.scroller,
  (el, prev) => {
    prev?.removeEventListener("scroll", syncScroll);
    el?.addEventListener("scroll", syncScroll, { passive: true });
    syncScroll();
  },
  { immediate: true }
);

watch(items, () =>
  nextTick(() => {
    syncScroll();
    scrollRailToNewest();
  })
);

onMounted(() => {
  syncScroll();
  scrollRailToNewest();
});
onBeforeUnmount(() => props.scroller?.removeEventListener("scroll", syncScroll));
</script>

<template>
  <nav v-if="items.length" class="msg-rail" aria-label="Prompts in this chat">
    <ol ref="listEl">
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

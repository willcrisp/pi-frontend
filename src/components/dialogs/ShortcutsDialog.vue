<!--
  Keyboard shortcut reference, opened with "?" or the header's ? button.

  Every shortcut this app has was previously discoverable only by reading the
  source: the palette, the find bar and the model/reasoning steppers have no
  on-screen affordance naming their key. This is that affordance.

  Always mounted from App.vue so it owns its own global hotkey, same pattern as
  CommandPalette.vue. Styles are scoped rather than a styles/ partial, per the
  note at the top of style.css.
-->
<script setup>
import { onBeforeUnmount, onMounted } from "vue";
import { shortcutsStore } from "../../stores/shortcuts.js";

// ⌘ on Apple hardware, Ctrl everywhere else. `navigator.platform` is deprecated
// but still the most reliable signal here, and the fallback is merely a label.
const isMac =
  typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
const mod = isMac ? "⌘" : "Ctrl";

const GROUPS = [
  {
    title: "Navigation",
    items: [
      { keys: [`${mod}+K`], description: "Jump to a session, or open a file" },
      { keys: [`${mod}+Shift+F`], description: "Find in this chat" },
      { keys: ["Esc"], description: "Close the open menu or dialog" },
      { keys: ["?"], description: "Show this list" },
    ],
  },
  {
    title: "The run",
    items: [
      // Escape is listed twice on purpose: it does whichever of these applies,
      // and "close the dialog" is the one that wins. Saying only the first left
      // the app with no keyboard way to stop an agent at all.
      { keys: ["Esc"], description: "Stop the agent — when nothing else is open" },
    ],
  },
  {
    title: "Composer",
    items: [
      { keys: ["Enter"], description: "Send — or steer, while a run is going" },
      { keys: ["Shift+Enter"], description: "New line" },
      { keys: ["/"], description: "Slash commands and skills, from an empty box" },
      { keys: ["@"], description: "Insert a file path from the project" },
      { keys: ["↑", "↓"], description: "Move through an open menu" },
      { keys: ["Tab"], description: "Accept the highlighted menu entry" },
    ],
  },
  {
    title: "Model",
    items: [
      { keys: [`${mod}+←`, `${mod}+→`], description: "Previous / next model" },
      { keys: [`${mod}+↑`, `${mod}+↓`], description: "More / less reasoning effort" },
    ],
  },
  {
    title: "When the agent asks",
    items: [
      { keys: ["1", "2", "3"], description: "Pick a permission reply, or a question's option" },
      { keys: ["Enter"], description: "Take the highlighted choice" },
      { keys: ["Esc"], description: "Deny a permission, or skip a question" },
    ],
  },
];

// "?" is Shift+/ on most layouts, so match the produced character rather than
// the physical key. Ignored while typing — otherwise it would be impossible to
// put a question mark in a prompt.
function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function onGlobalKey(e) {
  if (shortcutsStore.open && e.key === "Escape") {
    e.preventDefault();
    shortcutsStore.open = false;
    return;
  }
  if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTyping(e.target)) return;
  e.preventDefault();
  shortcutsStore.open = !shortcutsStore.open;
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) shortcutsStore.open = false;
}

onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKey));
</script>

<template>
  <div v-if="shortcutsStore.open" class="shortcuts-backdrop" @mousedown="onBackdrop">
    <div class="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <div class="shortcuts-head">
        <span class="shortcuts-title">Keyboard shortcuts</span>
        <button
          type="button"
          class="shortcuts-close"
          title="Close (Esc)"
          @click="shortcutsStore.open = false"
        >
          ×
        </button>
      </div>
      <div class="shortcuts-body">
        <section v-for="group in GROUPS" :key="group.title" class="shortcuts-group">
          <h4 class="shortcuts-group-title">{{ group.title }}</h4>
          <div v-for="item in group.items" :key="item.description" class="shortcuts-row">
            <span class="shortcuts-keys">
              <kbd v-for="k in item.keys" :key="k">{{ k }}</kbd>
            </span>
            <span class="shortcuts-desc">{{ item.description }}</span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcuts-backdrop {
  position: fixed;
  inset: 0;
  z-index: 130;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 24px 24px;
}

.shortcuts {
  width: 100%;
  max-width: 520px;
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.shortcuts-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.shortcuts-title {
  flex: 1;
  font-size: 13px;
  color: var(--fg);
}

.shortcuts-close {
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.shortcuts-close:hover {
  color: var(--fg);
}

.shortcuts-body {
  overflow: auto;
  padding: 4px 14px 14px;
}

.shortcuts-group {
  margin-top: 12px;
}

.shortcuts-group-title {
  margin: 0 0 6px;
  color: var(--dim);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.shortcuts-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 0;
  font-size: 12.5px;
}

/* Fixed column so the descriptions line up down the list. */
.shortcuts-keys {
  flex: none;
  width: 130px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.shortcuts-keys kbd {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
}

.shortcuts-desc {
  flex: 1;
  min-width: 0;
  color: var(--dim);
}
</style>

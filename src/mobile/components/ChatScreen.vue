<script setup>
// The transcript and the composer — the screen the app exists for.
import { computed, nextTick, ref, watch } from "vue";
import {
  abortSession,
  opencodeStore,
  refreshActiveMessages,
  sendPrompt,
  sendSteer,
  pendingSteersFor,
} from "../../stores/opencode.js";
import { projectsStore } from "../../stores/projects.js";
import MessageBubble from "./MessageBubble.vue";

const emit = defineEmits(["back"]);
const scroller = ref(null);
const text = ref("");
const box = ref(null);

const title = computed(() => {
  const s = projectsStore.sessions.find((x) => x.id === opencodeStore.activeSessionId);
  return s?.title || "New chat";
});

const steers = computed(() => pendingSteersFor(opencodeStore.activeSessionId).length);

// Only follow the transcript down when the user is already near the bottom.
// Yanking the view back while someone is scrolled up reading is the single most
// irritating thing a chat UI can do, and a streaming reply does it constantly.
function nearBottom() {
  const el = scroller.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

async function follow(force) {
  const stick = force || nearBottom();
  await nextTick();
  if (stick && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

watch(
  // Length alone misses a reply streaming into the last message, which is most
  // of a turn — so watch the tail's size too.
  () => [opencodeStore.messages.length, opencodeStore.messages.at(-1)?.text?.length],
  () => follow(false)
);

watch(() => opencodeStore.activeSessionId, () => follow(true));

function autosize() {
  const el = box.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

async function send() {
  const body = text.value.trim();
  if (!body) return;
  text.value = "";
  nextTick(autosize);
  // A prompt sent while the agent is mid-run is a steer, not a new turn — the
  // server would otherwise reject it or queue it invisibly. Same split the
  // desktop composer makes.
  if (opencodeStore.isStreaming) await sendSteer(body);
  else await sendPrompt(body, []);
  follow(true);
}

function stop() {
  abortSession();
}
</script>

<template>
  <div class="screen">
    <header>
      <button class="back" aria-label="Back" @click="emit('back')">‹</button>
      <span class="title">{{ title }}</span>
      <button class="refresh" aria-label="Refresh" @click="refreshActiveMessages()">⟳</button>
    </header>

    <div ref="scroller" class="transcript">
      <p v-if="opencodeStore.messagesLoading" class="note">Loading…</p>
      <p v-else-if="opencodeStore.messagesError" class="note bad">
        {{ opencodeStore.messagesError }}
      </p>

      <MessageBubble v-for="m in opencodeStore.messages" :key="m.id" :message="m" />

      <p v-if="opencodeStore.isStreaming" class="note working">Working…</p>
      <p v-if="steers" class="note">{{ steers }} queued for the agent's next turn</p>
    </div>

    <div class="composer">
      <textarea
        ref="box"
        v-model="text"
        rows="1"
        placeholder="Message…"
        autocapitalize="sentences"
        @input="autosize"
      />
      <!-- Stop and send are the same button in the same place, as on the desktop:
           during a run the square interrupts, otherwise the arrow sends. -->
      <button
        v-if="opencodeStore.isStreaming && !text.trim()"
        class="act stop"
        :disabled="opencodeStore.interrupting"
        aria-label="Stop"
        @click="stop"
      >
        ■
      </button>
      <button v-else class="act" :disabled="!text.trim()" aria-label="Send" @click="send">
        ↑
      </button>
    </div>
  </div>
</template>

<style scoped>
.screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
}

header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

.back,
.refresh {
  width: 44px;
  height: 44px;
  flex: none;
  border: 0;
  background: transparent;
  color: var(--fg-dim);
  font-size: 24px;
}

.title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 0;
}

.note {
  margin: 0;
  padding: 0 16px;
  font-size: 13px;
  color: var(--fg-dim);
}

.note.bad {
  color: var(--bad);
}

.note.working {
  color: var(--warn-fg);
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px calc(env(safe-area-inset-bottom, 0px) + 8px);
  border-top: 1px solid var(--line);
  background: var(--bg);
}

textarea {
  flex: 1;
  resize: none;
  /* 16px keeps Android from zooming the viewport on focus. */
  font-size: 16px;
  line-height: 1.4;
  padding: 11px 14px;
  max-height: 140px;
  border-radius: 20px;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--fg);
  font-family: inherit;
}

textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.act {
  flex: none;
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 18px;
}

.act:disabled {
  opacity: 0.4;
}

.act.stop {
  background: var(--bad);
}
</style>

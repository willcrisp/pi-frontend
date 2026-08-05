<!--
  Modal for approving/denying a tool call that needs permission. Backed by
  stores/permission.js — permissionStore.queue is a FIFO of pending requests from
  `permission.v2.asked`; this dialog always shows the queue head and advances as
  replies come back (see App.vue, which mounts it while the queue is non-empty).

  This is the most interruptive surface in the app and the one that stands between
  an agent and the filesystem, so four things it used to leave out are deliberate
  now:

  · **Keyboard.** 1/2/3 pick a reply, Enter takes the focused one, Escape denies.
    It was the only mouse-only modal in an app built around the keyboard, and the
    one you hit most often.
  · **Which session is asking.** The request carries a sessionID and nothing
    rendered it, so a sub-agent — or a chat in another project — could ask you to
    approve something and the modal looked identical to one from the chat on
    screen.
  · **How many are waiting.** A queue of three showed as one, with no hint that
    answering it would immediately be followed by another.
  · **What "always" actually costs.** It was styled exactly like "Allow once"
    while being the permanent grant, and the rule it saves (`entry.save`) was
    never shown. The way back is the padlock in the sidebar, which is not
    something you can be expected to know at the moment of the mis-click.
-->
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { permissionStore, respond } from "../../stores/permission.js";
import { opencodeStore } from "../../stores/opencode.js";
import { projectsStore } from "../../stores/projects.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const current = computed(() => permissionStore.queue[0] || null);
const waiting = computed(() => permissionStore.queue.length);

const onceBtn = ref(null);
const showDetail = ref(false);

// Which chat is asking. A sub-agent's request is called out specifically: it is
// the case where "approve this" is least likely to mean what the user assumes,
// because the work isn't the turn they are watching.
const asker = computed(() => {
  const id = current.value?.sessionID;
  if (!id) return null;
  const child = opencodeStore.childSessions[id];
  const session = projectsStore.sessions.find((s) => s.id === id);
  const title = (session?.title || "").trim();
  return {
    isChild: !!child,
    isActive: id === opencodeStore.activeSessionId,
    label: child ? child.name || child.agent || "a sub-agent" : title || id,
  };
});

// The rule "Allow always" would persist, in the server's own words.
const savedRule = computed(() => (current.value?.save || []).join(", "));

// The metadata dump is a fallback view, not the headline: `resources` above it
// usually says the same thing, and the two side by side read as two requests.
const metadataJson = computed(() => {
  const meta = current.value?.metadata;
  if (!meta || !Object.keys(meta).length) return "";
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return String(meta);
  }
});

function respondCurrent(reply) {
  if (!current.value || current.value.busy) return;
  respond(current.value.id, reply);
}

// 1/2/3 mirror the button order. Enter is left to the focused button, which is
// "Allow once".
function onKeydown(e) {
  if (!current.value || e.defaultPrevented) return;
  const byNumber = { 1: "once", 2: "always", 3: "reject" }[e.key];
  if (byNumber) {
    e.preventDefault();
    respondCurrent(byNumber);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

// Escape denies — the only safe direction for a stray keypress, since it can
// never grant anything. Through the shared stack, not a listener of its own:
// this modal is mounted on top of whatever was already open, and a hand-rolled
// listener meant one press both denied the request and closed the dialog under
// it. No backdrop handler is taken; a gating decision shouldn't be made by a
// click that misses the panel.
useDialogEscape(() => respondCurrent("reject"));

// Focus the least-consequential affirmative, so a reflexive Enter grants once
// rather than forever. Re-run per request: answering one advances the queue to
// the next without remounting, and the detail pane belongs to the old one.
watch(
  () => current.value?.id,
  (id) => {
    if (!id) return;
    showDetail.value = false;
    nextTick(() => onceBtn.value?.focus());
  },
  { immediate: true }
);
</script>

<template>
  <div v-if="current" class="connect-backdrop">
    <div class="connect-panel permission-panel">
      <div class="connect-head">
        <span>Permission requested</span>
        <span v-if="waiting > 1" class="permission-progress">1 of {{ waiting }}</span>
      </div>

      <p v-if="current.error" class="connect-error">{{ current.error }}</p>

      <div class="permission-action">
        <span class="permission-action-name">{{ current.action }}</span>
        <span v-if="asker" class="permission-asker" :class="{ elsewhere: asker.isChild || !asker.isActive }">
          <template v-if="asker.isChild">sub-agent · {{ asker.label }}</template>
          <template v-else-if="!asker.isActive">another chat · {{ asker.label }}</template>
          <template v-else>this chat</template>
        </span>
      </div>

      <ul v-if="current.resources.length" class="permission-resources">
        <li v-for="r in current.resources" :key="r">{{ r }}</li>
      </ul>

      <div v-if="metadataJson" class="permission-detail">
        <button type="button" class="permission-detail-toggle" @click="showDetail = !showDetail">
          {{ showDetail ? "▾" : "▸" }} details
        </button>
        <pre v-if="showDetail" class="permission-metadata">{{ metadataJson }}</pre>
      </div>

      <div class="connect-actions permission-actions">
        <button ref="onceBtn" type="button" :disabled="current.busy" @click="respondCurrent('once')">
          <span class="permission-key">1</span> Allow once
        </button>
        <button
          type="button"
          class="permission-always"
          :title="savedRule ? `Saves the rule ${savedRule} until you revoke it` : 'Grants this for good, until you revoke it'"
          :disabled="current.busy"
          @click="respondCurrent('always')"
        >
          <span class="permission-key">2</span> Allow always
        </button>
        <span class="permission-actions-spacer" />
        <button
          type="button"
          class="connect-secondary"
          title="Deny (Esc)"
          :disabled="current.busy"
          @click="respondCurrent('reject')"
        >
          <span class="permission-key">3</span> Deny
        </button>
      </div>

      <!-- Said here rather than discovered later: "always" is the one reply with
           consequences past this turn, and the way to undo it isn't obvious. -->
      <p class="connect-hint permission-hint">
        <template v-if="savedRule">
          “Always” saves <code>{{ savedRule }}</code> — revoke it any time from the
          padlock in the sidebar.
        </template>
        <template v-else>
          “Always” persists on the server — revoke it any time from the padlock in
          the sidebar.
        </template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.permission-progress {
  color: var(--dim);
  font-family: var(--mono);
  font-size: 11.5px;
}

.permission-action {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.permission-action-name {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}

/* Quiet for the chat you're looking at; marked when the request comes from
   somewhere else, which is the case worth noticing. */
.permission-asker {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--dim);
  font-size: 11px;
}

.permission-asker.elsewhere {
  border-color: var(--msg-user);
  color: var(--msg-user);
}

.permission-resources {
  margin: 6px 0 0;
  padding: 6px 10px;
  list-style: none;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 12px;
  max-height: 140px;
  overflow: auto;
}

.permission-resources li {
  padding: 1px 0;
  word-break: break-all;
}

.permission-detail-toggle {
  padding: 0;
  border: 0;
  background: none;
  color: var(--dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.permission-detail-toggle:hover {
  color: var(--fg);
}

.permission-metadata {
  margin: 6px 0 0;
  max-height: 200px;
  overflow: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.permission-actions {
  align-items: center;
}

.permission-actions-spacer {
  flex: 1;
}

/* The permanent grant reads as the heavier choice rather than a twin of
   "Allow once" — an outline, not a different colour, so it doesn't look like
   the recommended path either. */
.permission-always {
  border-style: dashed;
}

.permission-key {
  display: inline-block;
  min-width: 12px;
  margin-right: 4px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 10.5px;
}

.permission-hint code {
  font-family: var(--mono);
  color: var(--fg);
}
</style>

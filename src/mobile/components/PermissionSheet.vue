<script setup>
// The permission gate. A tool call that needs approval stops the run until it
// gets an answer, and GET /session/active keeps reporting "running" the whole
// time — so an ask the UI never shows is an agent hung forever. This is not an
// optional screen.
//
// A bottom sheet rather than a centred dialog: it lands under the thumb, which
// is where a three-way decision should be on a phone.
import { computed } from "vue";
import { respond } from "../../stores/permission.js";

const props = defineProps({ ask: { type: Object, required: true } });

// `resources` is what the call wants to touch; the desktop shows the full list
// and the metadata beside it. Here the first few are the useful part.
const resources = computed(() => (props.ask.resources || []).slice(0, 4));
const more = computed(() => Math.max(0, (props.ask.resources || []).length - 4));
</script>

<template>
  <div class="backdrop">
    <div class="sheet">
      <h2>Allow this?</h2>
      <p class="action">{{ ask.action || "tool call" }}</p>

      <ul v-if="resources.length" class="resources">
        <li v-for="r in resources" :key="r">{{ r }}</li>
        <li v-if="more" class="more">+{{ more }} more</li>
      </ul>

      <p v-if="ask.error" class="err">{{ ask.error }}</p>

      <div class="buttons">
        <button class="allow" :disabled="ask.busy" @click="respond(ask.id, 'once')">
          Allow once
        </button>
        <!-- "Always" is a persisted server-side rule with no way to revoke it
             from this app (the desktop has that list). It stays available because
             approving every file read one at a time on a phone is unusable, but it
             is not the primary button. -->
        <button class="always" :disabled="ask.busy" @click="respond(ask.id, 'always')">
          Always
        </button>
        <button class="reject" :disabled="ask.busy" @click="respond(ask.id, 'reject')">
          Reject
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  background: rgb(0 0 0 / 0.55);
}

.sheet {
  width: 100%;
  max-height: 80%;
  overflow-y: auto;
  padding: 22px 20px calc(env(safe-area-inset-bottom, 0px) + 20px);
  border-radius: 20px 20px 0 0;
  background: var(--bg-raised);
}

h2 {
  margin: 0 0 6px;
  font-size: 18px;
}

.action {
  margin: 0 0 14px;
  color: var(--fg-dim);
  font-family: var(--mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.resources {
  margin: 0 0 16px;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg);
  list-style: none;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--fg-dim);
}

.resources li {
  overflow-wrap: anywhere;
}

.more {
  opacity: 0.6;
}

.err {
  margin: 0 0 12px;
  color: var(--bad);
  font-size: 13px;
}

.buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

button {
  padding: 15px;
  border: 0;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
}

button:disabled {
  opacity: 0.5;
}

.allow {
  background: var(--accent);
  color: var(--accent-fg);
}

.always {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
}

.reject {
  background: transparent;
  color: var(--bad);
}
</style>

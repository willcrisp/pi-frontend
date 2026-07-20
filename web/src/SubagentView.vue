<script setup>
// Rich inline view for a `subagent` tool call (single/parallel/chain
// dispatch), replacing the generic <details class="tool"> rendering in
// MessageView.vue. `details` on the tool result is a whole-state snapshot
// (see pi.js's tool_execution_update handling) so this component just
// re-renders from store.toolResults[toolCallId] reactively — no local
// accumulation needed.
import { computed, onUnmounted, ref, watch } from "vue";
import { store, subagentDetails } from "./pi.js";

const props = defineProps({
  toolCallId: { type: String, required: true },
  args: { type: [Object, String], default: null },
});

const r = computed(() => store.toolResults[props.toolCallId]);
const details = computed(() => subagentDetails(r.value));
const results = computed(() => details.value?.results || null);

// Live-ticking clock for the overall duration while the tool call is still
// running; started/stopped by the watcher below and cleared on unmount.
const now = ref(Date.now());
const isRunning = computed(() => !!r.value?.running);
let timer = null;
watch(
  isRunning,
  (running) => {
    if (running && !timer) {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    } else if (!running && timer) {
      clearInterval(timer);
      timer = null;
    }
  },
  { immediate: true }
);
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const overallDurationMs = computed(() => {
  const started = r.value?.startedAt;
  if (!started) return null; // history backfill has no startedAt — show nothing
  const end = r.value.endedAt || now.value;
  return end - started;
});

function resultStatus(res) {
  if (res.exitCode === -1) return "running";
  if (res.errorMessage || res.exitCode > 0) return "error";
  return "done";
}

const overallStatus = computed(() => {
  if (!results.value) return "starting";
  if (results.value.some((res) => resultStatus(res) === "running")) return "running";
  if (results.value.some((res) => resultStatus(res) === "error")) return "error";
  return "done";
});

function messageText(m) {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function finalOutputText(res) {
  const messages = res.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messageText(messages[i]);
  }
  return "";
}

function argsSummary(args) {
  if (!args) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n) {
  if (n == null) return "—";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function formatDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

// Before any details snapshot has arrived (dispatch just started), derive
// placeholder cards straight from the tool call's arguments so the UI isn't
// empty during that first round-trip.
function parseArgs(args) {
  if (!args) return null;
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

const placeholderCards = computed(() => {
  if (details.value) return null;
  const parsed = parseArgs(props.args);
  if (!parsed) return [{ agent: null, task: null }];
  if (Array.isArray(parsed.tasks)) return parsed.tasks.map((t) => ({ agent: t?.agent, task: t?.task }));
  if (Array.isArray(parsed.chain)) return parsed.chain.map((t) => ({ agent: t?.agent, task: t?.task }));
  if (parsed.agent || parsed.task) return [{ agent: parsed.agent, task: parsed.task }];
  return [{ agent: null, task: null }];
});
</script>

<template>
  <div :id="'tc-' + toolCallId" class="subagent">
    <div class="subagent-header">
      <span class="subagent-label">sub-agents</span>
      <span v-if="details" class="subagent-mode">{{ details.mode }}</span>
      <span class="subagent-status" :class="overallStatus">
        <span class="subagent-dot" :class="overallStatus"></span>
        {{ overallStatus }}
      </span>
      <span v-if="overallDurationMs != null" class="subagent-duration">{{ formatDuration(overallDurationMs) }}</span>
    </div>

    <template v-if="results">
      <details
        v-for="(res, i) in results"
        :key="i"
        class="subagent-card"
        :open="resultStatus(res) === 'running'"
      >
        <summary title="Click to expand/collapse">
          <span class="subagent-dot" :class="resultStatus(res)"></span>
          <span v-if="details.mode === 'chain'" class="subagent-step">step {{ res.step }}</span>
          <span class="subagent-agent">{{ res.agent }}</span>
          <span class="subagent-model">{{ res.model || "" }}</span>
          <span class="subagent-usage">
            {{ formatTokens((res.usage?.input || 0) + (res.usage?.output || 0)) }} tokens ·
            {{ formatCost(res.usage?.cost) }} · {{ res.usage?.turns ?? 0 }} turns
          </span>
        </summary>
        <div class="subagent-body">
          <p v-if="res.task" class="subagent-task">{{ res.task }}</p>

          <div class="subagent-activity">
            <template v-for="(m, mi) in res.messages || []" :key="mi">
              <template v-if="m.role === 'assistant'">
                <template v-for="(block, bi) in Array.isArray(m.content) ? m.content : []" :key="bi">
                  <p v-if="block.type === 'text' && block.text" class="subagent-line">{{ block.text }}</p>
                  <p v-else-if="block.type === 'toolCall'" class="subagent-line subagent-toolcall">
                    <span class="subagent-toolcall-name">{{ block.name }}</span> {{ argsSummary(block.arguments) }}
                  </p>
                </template>
              </template>
              <p v-else-if="m.role === 'toolResult'" class="subagent-line subagent-toolresult">{{ messageText(m) }}</p>
            </template>
          </div>

          <pre v-if="finalOutputText(res)" class="subagent-output">{{ finalOutputText(res) }}</pre>

          <div v-if="res.errorMessage" class="subagent-error-msg">{{ res.errorMessage }}</div>
          <pre v-if="res.stderr && (res.errorMessage || res.exitCode > 0)" class="subagent-stderr">{{ res.stderr }}</pre>
        </div>
      </details>
    </template>

    <template v-else>
      <div v-for="(card, i) in placeholderCards" :key="i" class="subagent-card subagent-placeholder">
        <div class="subagent-placeholder-row">
          <span class="subagent-dot running"></span>
          <span v-if="card.agent" class="subagent-agent">{{ card.agent }}</span>
          <span class="subagent-starting">starting…</span>
        </div>
        <p v-if="card.task" class="subagent-task">{{ card.task }}</p>
      </div>
    </template>
  </div>
</template>

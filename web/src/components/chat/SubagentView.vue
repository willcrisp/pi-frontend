<!--
  Rich inline view for a `subagent` tool call, replacing the generic
  <details class="tool"> rendering in MessageView.vue.

  A dispatch spawns a CHILD SESSION whose turn streams over the same
  /api/event connection under its own sessionID; opencode.js routes those
  events into a child record and exposes it by callID. So this component is
  a pure render of childForCall(callID) — no local accumulation.

  It renders from TWO sources, because the child is the richer one but not
  the reliable one: the child session when it has been linked, and always the
  dispatching tool call's own `state` (status, output, error). A server that
  never reports the child's session id still produces a card that tracks the
  call, shows its result, and opens. The card is always a <details> for that
  reason — there is no state in which there is nothing to look at.

  One card per call: V2 has no chain/parallel dispatch primitive, so
  parallelism is just several concurrent calls, one card each.

  Cost is always 0 on this server (see docs/subagents-alfuat.md) — show
  tokens, never dollars.
-->
<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { childForCall, opencodeStore } from "../../stores/opencode.js";
import { openSubagentSession } from "../../stores/projects.js";
import { renderMarkdown } from "../../lib/markdown.js";

const props = defineProps({
  callID: { type: String, required: true },
  args: { type: [Object, String], default: null },
  // The dispatching tool part's own state: {status, output?, error?}.
  state: { type: Object, default: null },
});

const child = computed(() => childForCall(props.callID));

const parsedArgs = computed(() => parseArgs(props.args));

// The dispatch input is the earliest (and most complete) source for these —
// the child session record only learns them once it reports in.
const agentName = computed(() => child.value?.agent || parsedArgs.value?.agent || null);
const taskText = computed(() => parsedArgs.value?.prompt || child.value?.task || null);
const label = computed(() => parsedArgs.value?.description || child.value?.title || null);

// Model arrives as a Model.Ref-ish object ({id, providerID, variant}) from
// both the session record and the child's first step.
const modelLabel = computed(() => {
  const m = child.value?.model;
  if (!m) return "";
  if (typeof m === "string") return m;
  return m.variant && m.variant !== "default" ? `${m.id} (${m.variant})` : m.id || "";
});

// Status comes from whichever source knows more. The tool call is
// authoritative once it has finished — a child whose own `execution.succeeded`
// we never saw must not leave the card spinning after the dispatch returned —
// and the child drives it while the call is still in flight.
const toolStatus = computed(() => (props.state && props.state.status) || "pending");
const status = computed(() => {
  const childStatus = child.value?.status;
  if (toolStatus.value === "error" || childStatus === "error") return "error";
  if (toolStatus.value === "completed") return "completed";
  if (childStatus === "completed") return "completed";
  if (childStatus === "running" || toolStatus.value === "running") return "running";
  return "starting";
});

// The pre-existing `.subagent-dot` / `.subagent-status` CSS is keyed on
// running/done/error, so map the status vocabulary onto it.
const statusClass = computed(() =>
  ({ completed: "done", starting: "running" })[status.value] || status.value
);

// Open while the sub-agent is working, then leave it as the user left it —
// auto-collapsing on completion would snatch away the result they were
// waiting for.
const open = ref(false);
let userToggled = false;
watch(
  status,
  (s) => {
    if (!userToggled && (s === "running" || s === "starting")) open.value = true;
  },
  { immediate: true }
);
function onToggle(e) {
  userToggled = true;
  open.value = e.target.open;
}

const errorText = computed(() => child.value?.error || (props.state && props.state.error) || "");

// Drilling in needs the child's own session id, which only exists once the
// dispatch has been linked — a card rendering from the tool call alone has
// nothing to open, so the control is hidden rather than dead.
const canOpenSession = computed(() => !!child.value?.sessionID);

function openSession() {
  const c = child.value;
  if (!c?.sessionID) return;
  openSubagentSession(c.sessionID, c.parentSessionID || opencodeStore.activeSessionId);
}

const totalTokens = computed(() => {
  const t = child.value?.tokens;
  if (!t) return null;
  return (t.input || 0) + (t.output || 0);
});

// Live-ticking clock for the card duration while the sub-agent is running;
// started/stopped by the watcher below and cleared on unmount.
const now = ref(Date.now());
const isRunning = computed(() => status.value === "running" || status.value === "starting");
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

const durationMs = computed(() => {
  const started = child.value?.startedAt;
  if (!started) return null; // history backfill without a timestamp — show nothing
  return (child.value.endedAt || now.value) - started;
});

// Index of the message the final answer comes from, so the activity log can
// skip it — otherwise the agent's conclusion shows up twice (once mid-log,
// once in the Result block below it).
function finalMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && partsText(m).trim()) return i;
  }
  return -1;
}

function partsText(m) {
  if (typeof m.text === "string" && m.text) return m.text;
  return (m.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text || "")
    .join("");
}

// The sub-agent's answer: its own last message when the transcript is here,
// otherwise what the dispatching tool call returned — which is the same text,
// and the only copy of it when the child was never linked.
const finalOutputText = computed(() => {
  const messages = child.value?.messages || [];
  const i = finalMessageIndex(messages);
  if (i !== -1) return partsText(messages[i]);
  return (props.state && props.state.output) || "";
});

// Flatten the child's transcript into a display list: its narration (as
// markdown), the tools it called, and their (clamped) outputs. The child
// speaks the same normalized message shape as the main transcript, so this
// walks `parts` exactly as MessageView does.
const activityItems = computed(() => {
  const messages = child.value?.messages || [];
  const final = finalMessageIndex(messages);
  const items = [];
  messages.forEach((m, mi) => {
    if (m.role !== "assistant") return;
    for (const part of m.parts || []) {
      if (part.type === "text") {
        if (mi !== final && (part.text || "").trim()) items.push({ kind: "text", text: part.text });
      } else if (part.type === "tool") {
        items.push({
          kind: "tool",
          name: part.tool || "tool",
          args: argsSummary(part.input),
        });
        const out = part.state && (part.state.output || part.state.error);
        if (out && String(out).trim()) items.push({ kind: "result", text: truncate(out, 400) });
      }
    }
  });
  return items;
});

// Tool arguments are shown as a one-line hint next to the tool name, so
// prefer the few fields that actually identify the call over raw JSON.
function argsSummary(args) {
  if (!args) return "";
  const parsed = parseArgs(args);
  if (parsed && typeof parsed === "object") {
    const key = ["file_path", "path", "command", "pattern", "url", "query"].find(
      (k) => typeof parsed[k] === "string"
    );
    if (key) return truncate(parsed[key], 90);
    const vals = Object.values(parsed).filter((v) => typeof v === "string");
    if (vals.length === 1) return truncate(vals[0], 90);
  }
  return truncate(typeof args === "string" ? args : JSON.stringify(args), 90);
}

function truncate(s, n) {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function parseArgs(args) {
  if (!args) return null;
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}
</script>

<template>
  <div :id="'tc-' + callID" class="subagent">
    <div class="subagent-header">
      <span class="subagent-label">sub-agent</span>
      <span v-if="label" class="subagent-mode">{{ label }}</span>
      <span class="subagent-status" :class="statusClass">
        <span class="subagent-dot" :class="statusClass"></span>
        {{ status }}
      </span>
      <span v-if="durationMs != null" class="subagent-duration">{{ formatDuration(durationMs) }}</span>
      <button
        v-if="canOpenSession"
        type="button"
        class="subagent-open"
        title="Open this sub-agent's own session"
        @click="openSession"
      >
        open ↗
      </button>
    </div>

    <details class="subagent-card" :open="open" @toggle="onToggle">
      <summary title="Click to expand/collapse">
        <span class="subagent-dot" :class="statusClass"></span>
        <span class="subagent-agent">{{ agentName || "agent" }}</span>
        <span class="subagent-model">{{ modelLabel }}</span>
        <span v-if="totalTokens != null" class="subagent-usage">{{ formatTokens(totalTokens) }} tokens</span>
      </summary>
      <div class="subagent-body">
        <section v-if="taskText" class="subagent-section">
          <h4 class="subagent-section-title">Task</h4>
          <div class="subagent-task markdown" v-html="renderMarkdown(taskText)"></div>
        </section>

        <section v-if="activityItems.length" class="subagent-section">
          <h4 class="subagent-section-title">Activity</h4>
          <div class="subagent-activity">
            <template v-for="(item, ii) in activityItems" :key="ii">
              <div v-if="item.kind === 'text'" class="subagent-line markdown" v-html="renderMarkdown(item.text)"></div>
              <p v-else-if="item.kind === 'tool'" class="subagent-line subagent-toolcall">
                <span class="subagent-toolcall-name">{{ item.name }}</span>
                <span v-if="item.args" class="subagent-toolcall-args">{{ item.args }}</span>
              </p>
              <p v-else class="subagent-line subagent-toolresult">{{ item.text }}</p>
            </template>
          </div>
        </section>

        <section v-if="finalOutputText" class="subagent-section">
          <h4 class="subagent-section-title">Result</h4>
          <div class="subagent-output markdown" v-html="renderMarkdown(finalOutputText)"></div>
        </section>

        <div v-if="errorText" class="subagent-error-msg">{{ errorText }}</div>

        <!-- No child session linked to this call. Say which of the two cases
             it is instead of leaving the card looking broken. -->
        <p v-if="!child" class="subagent-note">
          <template v-if="status === 'running' || status === 'starting'">
            Waiting for the sub-agent's session to report in — its live transcript
            appears here once it does.
          </template>
          <template v-else-if="!finalOutputText">
            This server didn't report a session for the dispatch, so there's no
            transcript to show.
          </template>
          <template v-else>
            Result only — this server didn't report a session for the dispatch, so
            the step-by-step activity isn't available.
          </template>
        </p>
      </div>
    </details>
  </div>
</template>

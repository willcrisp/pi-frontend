<script setup>
import { computed } from "vue";
import { store } from "./pi.js";

// Flattened from store.toolResults rather than tracked separately, so a
// reconnect's get_messages backfill can't produce duplicate entries.
// Detection is heuristic: any tool result carrying `details.results` with
// per-item `usage` is treated as a sub-agent dispatch (this is the shape
// produced by pi-mono's example `subagent` extension — see README).
const subagentRuns = computed(() => {
  const runs = [];
  for (const [toolCallId, r] of Object.entries(store.toolResults)) {
    const results = r.details?.results;
    if (!Array.isArray(results)) continue;
    const durationMs = r.startedAt && r.endedAt ? r.endedAt - r.startedAt : null;
    results.forEach((sub, i) => {
      if (!sub || typeof sub !== "object") return;
      runs.push({
        id: `${toolCallId}:${i}`,
        agent: sub.agent || sub.name || "agent",
        model: sub.model || null,
        usage: sub.usage || null,
        stopReason: sub.stopReason || null,
        errorMessage: sub.errorMessage || null,
        durationMs,
      });
    });
  }
  return runs;
});

const subagentTotals = computed(() => {
  return subagentRuns.value.reduce(
    (acc, r) => {
      const u = r.usage;
      if (!u) return acc;
      acc.input += u.input || 0;
      acc.output += u.output || 0;
      acc.cost += u.cost || 0;
      return acc;
    },
    { input: 0, output: 0, cost: 0 }
  );
});

const grandTotalTokens = computed(() => {
  const session = store.sessionStats?.tokens?.total || 0;
  return session + subagentTotals.value.input + subagentTotals.value.output;
});

const grandTotalCost = computed(() => {
  const session = store.sessionStats?.cost || 0;
  return session + subagentTotals.value.cost;
});

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
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
</script>

<template>
  <div class="usage" tabindex="0">
    <svg
      class="usage-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="M2 13.5V2M2 13.5H14"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
      <rect x="4" y="9" width="2" height="4" fill="currentColor" />
      <rect x="7.5" y="6" width="2" height="7" fill="currentColor" />
      <rect x="11" y="3.5" width="2" height="9.5" fill="currentColor" />
    </svg>

    <div class="usage-popover">
      <template v-if="store.sessionStats">
        <div class="usage-row usage-total">
          <span>Session tokens</span>
          <strong>{{ formatTokens(store.sessionStats.tokens?.total) }}</strong>
        </div>
        <div class="usage-row usage-dim">
          <span>input / output</span>
          <span
            >{{ formatTokens(store.sessionStats.tokens?.input) }} /
            {{ formatTokens(store.sessionStats.tokens?.output) }}</span
          >
        </div>
        <div class="usage-row usage-dim">
          <span>cache read / write</span>
          <span
            >{{ formatTokens(store.sessionStats.tokens?.cacheRead) }} /
            {{ formatTokens(store.sessionStats.tokens?.cacheWrite) }}</span
          >
        </div>
        <div class="usage-row">
          <span>cost</span>
          <span>{{ formatCost(store.sessionStats.cost) }}</span>
        </div>
        <div class="usage-row usage-dim" v-if="store.sessionStats.contextUsage?.percent != null">
          <span>context used</span>
          <span>{{ Math.round(store.sessionStats.contextUsage.percent) }}%</span>
        </div>
      </template>
      <div v-else class="usage-row usage-dim">no session stats yet</div>

      <div class="usage-sep"></div>

      <template v-if="subagentRuns.length">
        <div class="usage-row usage-heading">
          <span>Sub-agents</span>
          <strong>{{ formatTokens(grandTotalTokens) }} total</strong>
        </div>
        <div v-for="run in subagentRuns" :key="run.id" class="usage-agent">
          <div class="usage-row">
            <span class="usage-agent-name" :class="{ error: run.errorMessage }">{{ run.agent }}</span>
            <span class="usage-dim">{{ run.model || "" }}</span>
          </div>
          <div class="usage-row usage-dim">
            <span>{{ formatTokens((run.usage?.input || 0) + (run.usage?.output || 0)) }} tok · {{ formatCost(run.usage?.cost) }}</span>
            <span>{{ formatDuration(run.durationMs) }}</span>
          </div>
        </div>
      </template>
      <div v-else class="usage-row usage-dim">no sub-agents used this session</div>
    </div>
  </div>
</template>

<!--
  Hover-triggered popover with session-level token/cost stats
  (store.sessionStats) plus a per-sub-agent usage breakdown.
-->
<script setup>
import { computed } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";

import { gatewayCostFor } from "../../stores/usage.js";

// The popover stays a live, at-a-glance view of the session on screen; history
// and cross-project totals need more room than a hover target, so they live in
// UsageDialog.vue and this is the way in.
defineEmits(["open-usage"]);

// A provider configured without pricing gives OpenCode nothing to compute a
// cost from, so `sessionStats.cost` sits at exactly 0 no matter how much the
// session actually spent. When the gateway's own figure has been loaded, show
// that instead of a zero the user would reasonably read as "free".
const gatewayCost = computed(() => {
  if (store.sessionStats?.cost) return null;
  const m = store.selectedModel;
  return m ? gatewayCostFor([m.modelID]) : null;
});

// Each sub-agent dispatch is a child session, metered separately from the
// parent — its tokens are additive with the session totals above, never a
// double-count of them (docs/subagents-alfuat.md).
const subagentRuns = computed(() =>
  Object.values(store.childSessions || {}).map((child) => ({
    id: child.sessionID,
    agent: child.agent || "agent",
    model: modelLabel(child.model),
    tokens: (child.tokens?.input || 0) + (child.tokens?.output || 0),
    error: child.error || null,
    running: child.status === "running",
    durationMs: child.startedAt && child.endedAt ? child.endedAt - child.startedAt : null,
  }))
);

const subagentTotalTokens = computed(() =>
  subagentRuns.value.reduce((sum, r) => sum + r.tokens, 0)
);

function modelLabel(m) {
  if (!m) return "";
  return typeof m === "string" ? m : m.id || "";
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
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
</script>

<template>
  <div class="usage" tabindex="0" title="Token usage & cost">
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
          <span>cost{{ gatewayCost != null ? " (gateway)" : "" }}</span>
          <span>{{ formatCost(gatewayCost != null ? gatewayCost : store.sessionStats.cost) }}</span>
        </div>
        <div class="usage-row usage-dim" v-if="store.sessionStats.contextUsage?.percent != null">
          <!-- Flagged when it's the server's own accounting rather than our
               estimate against the model catalog's context limit. -->
          <span>context used{{ store.sessionStats.contextUsage.fromServer ? "" : " (est.)" }}</span>
          <span>
            {{ Math.round(store.sessionStats.contextUsage.percent) }}%
            <template v-if="store.sessionStats.contextUsage.limit">
              · {{ formatTokens(store.sessionStats.contextUsage.used) }} /
              {{ formatTokens(store.sessionStats.contextUsage.limit) }}
            </template>
          </span>
        </div>
      </template>
      <div v-else class="usage-row usage-dim">no session stats yet</div>

      <div class="usage-sep"></div>

      <template v-if="subagentRuns.length">
        <div class="usage-row usage-heading">
          <span>Sub-agents</span>
          <strong>{{ formatTokens(subagentTotalTokens) }} total</strong>
        </div>
        <div v-for="run in subagentRuns" :key="run.id" class="usage-agent">
          <div class="usage-row">
            <span class="usage-agent-name" :class="{ error: run.error }">
              <span v-if="run.running" class="subagent-dot running"></span>
              {{ run.agent }}
            </span>
            <span class="usage-dim">{{ run.model }}</span>
          </div>
          <div class="usage-row usage-dim">
            <span>{{ formatTokens(run.tokens) }} tok</span>
            <span>{{ run.running ? "running…" : formatDuration(run.durationMs) }}</span>
          </div>
        </div>
      </template>
      <div v-else class="usage-row usage-dim">no sub-agents used this session</div>

      <div class="usage-sep"></div>
      <button type="button" class="usage-more" @click.stop="$emit('open-usage')">
        All usage &amp; history →
      </button>
    </div>
  </div>
</template>

<style scoped>
.usage-more {
  width: 100%;
  background: none;
  border: none;
  padding: 2px 0;
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
</style>

<!--
  Top chat bar: connection dot, wordmark, Coder menu, model label, clickable
  session-name/usage title (opens the rename dialog), a running-sub-agent
  count badge, usage popover, and the color-profile / sub-agent-manage
  buttons. All derived data (token summaries, "dumb zone" warning, sub-agent
  badge) is computed from `store` (pi.js) — no local state beyond computeds.
-->
<script setup>
import { computed } from "vue";
import { store, subagentDetails } from "../../stores/pi.js";
import { openAgents } from "../../stores/agents.js";
import { openRenameDialog } from "../../stores/renameDialog.js";
import UsagePopover from "../popovers/UsagePopover.vue";
import ColorProfilePopover from "../popovers/ColorProfilePopover.vue";
import SshPopover from "../popovers/SshPopover.vue";
import CoderMenu from "../popovers/CoderMenu.vue";
import pixelBrainFire from "../../assets/pixel-brain-fire.svg";

const DUMB_ZONE_THRESHOLD = 150_000;

const modelLabel = computed(() =>
  store.model ? store.model.id || store.model.name : "…"
);

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Cumulative input/output tokens for the session. Cache tokens are deliberately
// omitted here; the usage popover shows them separately.
const tokenSummary = computed(() => {
  const t = store.sessionStats?.tokens;
  if (!t) return null;
  return `${fmtTokens(t.input || 0)} in / ${fmtTokens(t.output || 0)} out`;
});

// Use raw counts as the transition key so an update still animates when the
// compact display (for example, 1.2k) has not rounded to a new value yet.
const tokenSummaryKey = computed(() => {
  const t = store.sessionStats?.tokens;
  return t ? `${t.input || 0}:${t.output || 0}` : null;
});

// Summed across every sub-agent dispatch in this chat, same flattening as
// UsagePopover.vue (detection via the shared subagentDetails() helper).
const subagentTokens = computed(() => {
  let input = 0;
  let output = 0;
  for (const r of Object.values(store.toolResults)) {
    const details = subagentDetails(r);
    if (!details) continue;
    for (const sub of details.results) {
      const u = sub && typeof sub === "object" ? sub.usage : null;
      if (u) {
        input += u.input || 0;
        output += u.output || 0;
      }
    }
  }
  return input + output > 0 ? `sub ${fmtTokens(input)}/${fmtTokens(output)}` : null;
});

const contextPercent = computed(() => {
  const percent = store.sessionStats?.contextUsage?.percent;
  return percent != null ? `${Math.round(percent)}% ctx` : null;
});

// The dumb zone is based on this chat's cumulative input/output usage. Pi's
// session totals exclude the separately reported sub-agent usage, which is
// exactly what we want here.
const dumbZoneActive = computed(() => {
  const tokens = store.sessionStats?.tokens;
  if (!tokens) return false;
  return (tokens.input || 0) + (tokens.output || 0) > DUMB_ZONE_THRESHOLD;
});

const titleText = computed(() => {
  const parts = [];
  if (store.sessionName) parts.push(store.sessionName);
  if (tokenSummary.value != null) parts.push(tokenSummary.value);
  if (dumbZoneActive.value) parts.push("dumb zone: over 150k input/output tokens");
  if (contextPercent.value) parts.push(contextPercent.value);
  if (subagentTokens.value) parts.push(subagentTokens.value);
  return parts.join(" · ");
});

function renameSession() {
  openRenameDialog();
}

// Currently-running sub-agents across all tool calls in this project's chat,
// for the header badge. Counts individual dispatched tasks (not tool calls)
// when a details snapshot is available, falling back to 1 per still-running
// dispatch before its first snapshot arrives.
const subagentBadge = computed(() => {
  let count = 0;
  let firstId = null;
  for (const [id, r] of Object.entries(store.toolResults)) {
    if (!r.running) continue;
    const details = subagentDetails(r);
    if (r.name !== "subagent" && !details) continue;
    const n = details ? details.results.filter((res) => res.exitCode === -1).length : 1;
    count += n;
    if (n > 0 && !firstId) firstId = id;
  }
  return { count, firstId };
});

function scrollToRunningSubagent() {
  const id = subagentBadge.value.firstId;
  if (!id) return;
  document.getElementById(`tc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
</script>

<template>
  <header>
    <div class="header-left">
      <SshPopover />
      <span class="wordmark" title="pi coding agent">pi</span>
      <CoderMenu />
      <span :title="modelLabel">{{ modelLabel }}</span>
    </div>
    <button class="header-title" :title="titleText" @click="renameSession">
      <span class="header-title-content">
        <span v-if="store.sessionName">{{ store.sessionName }}</span>
        <template v-if="tokenSummary != null">
          <span v-if="store.sessionName"> · </span>
          <Transition name="token-roll" mode="out-in">
            <span :key="tokenSummaryKey" class="token-summary-value">{{ tokenSummary }}</span>
          </Transition>
        </template>
        <img
          v-if="dumbZoneActive"
          class="dumb-zone-brain"
          :src="pixelBrainFire"
          alt="Warning, entering the dumb zone"
          title="warning, entering the dumb zone"
        />
        <span v-if="contextPercent"> · {{ contextPercent }}</span>
        <span v-if="subagentTokens"> · {{ subagentTokens }}</span>
      </span>
    </button>
    <div class="header-right">
      <button
        v-if="subagentBadge.count > 0"
        class="subagent-badge"
        type="button"
        title="Jump to running sub-agent"
        @click="scrollToRunningSubagent"
      >
        <span class="subagent-badge-dot"></span>
        {{ subagentBadge.count }} agent{{ subagentBadge.count === 1 ? "" : "s" }}
      </button>
      <UsagePopover class="header-usage" />
      <button type="button" class="colors-trigger" title="manage sub-agents" @click="openAgents">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="5.5" cy="5" r="2" stroke="currentColor" stroke-width="1.1" />
          <path d="M1.8 13c0-2 1.6-3.3 3.7-3.3S9.2 11 9.2 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
          <circle cx="11" cy="5.5" r="1.6" stroke="currentColor" stroke-width="1.1" />
          <path d="M8.7 9.9c.6-.5 1.4-.8 2.3-.8 1.9 0 3.4 1.2 3.4 2.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
        </svg>
      </button>
      <ColorProfilePopover />
    </div>
  </header>
</template>

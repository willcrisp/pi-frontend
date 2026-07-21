<script setup>
import { computed } from "vue";
import { store, subagentDetails } from "./pi.js";
import { openAgents } from "./agents.js";
import { openRenameDialog } from "./renameDialog.js";
import UsagePopover from "./UsagePopover.vue";
import ColorProfilePopover from "./ColorProfilePopover.vue";
import SshPopover from "./SshPopover.vue";
import CoderMenu from "./CoderMenu.vue";

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

const titleText = computed(() => {
  const name = store.sessionName || "untitled";
  if (tokenSummary.value == null) return name;
  const parts = [tokenSummary.value];
  if (contextPercent.value) parts.push(contextPercent.value);
  if (subagentTokens.value) parts.push(subagentTokens.value);
  return `${name} · ${parts.join(" · ")}`;
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
        <span>{{ store.sessionName || "untitled" }}</span>
        <template v-if="tokenSummary != null">
          <span> · </span>
          <Transition name="token-roll" mode="out-in">
            <span :key="tokenSummaryKey" class="token-summary-value">{{ tokenSummary }}</span>
          </Transition>
        </template>
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

<!--
  Top chat bar for OpenCode V2: connection indicator, active session title with
  running token/context counters, git branch badge (PTY-backed, localStorage-cached — see stores/git.js), usage popover.

  The branch list is deliberately READ-ONLY: checking out from here mutates a real
  working tree that the agent may be mid-task in, and a single stray click is enough
  to do it. Switch branches in the session itself, not from this badge.
-->
<script setup>
import { computed, ref } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import { activeSessionDirectory, projectsStore } from "../../stores/projects.js";
import { gitStore, fetchBranches } from "../../stores/git.js";
import ColorProfilePopover from "../popovers/ColorProfilePopover.vue";
import ModelFilterPopover from "../popovers/ModelFilterPopover.vue";
import SshPopover from "../popovers/SshPopover.vue";
import UsagePopover from "../popovers/UsagePopover.vue";

// Title comes from the session record the server creates (auto-titled from the
// first prompt), not a synthesised id label. Until that auto-title lands the
// server uses a placeholder ("New session - <iso timestamp>"); show nothing
// rather than that noise.
const PLACEHOLDER_TITLE = /^new session\b/i;

const sessionTitle = computed(() => {
  // Nothing selected: the wordmark on the left already says "radius", so leave
  // the centre empty rather than repeating it.
  if (!store.activeSessionId) return null;
  const s = projectsStore.sessions.find((x) => x.id === store.activeSessionId);
  const t = (s?.title || "").trim();
  if (!t || PLACEHOLDER_TITLE.test(t)) return null;
  return t;
});

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Cumulative input/output tokens for the session. Cache tokens are deliberately
// omitted here; the usage popover shows them separately.
const tokenSummary = computed(() => {
  const t = store.sessionStats?.tokens;
  if (!t || !(t.input || t.output)) return null;
  return `${fmtTokens(t.input || 0)} in / ${fmtTokens(t.output || 0)} out`;
});

// Use raw counts as the transition key so an update still animates when the
// compact display (for example, 1.2k) has not rounded to a new value yet.
const tokenSummaryKey = computed(() => {
  const t = store.sessionStats?.tokens;
  return t ? `${t.input || 0}:${t.output || 0}` : null;
});

const contextPercent = computed(() => {
  const percent = store.sessionStats?.contextUsage?.percent;
  return percent ? `${Math.round(percent)}% ctx` : null;
});

const titleText = computed(() =>
  [sessionTitle.value, tokenSummary.value, contextPercent.value].filter(Boolean).join(" · ")
);

const directory = computed(() => activeSessionDirectory());
const git = computed(() => (directory.value ? gitStore.byDirectory[directory.value] : null));
const branchOpen = ref(false);

function toggleBranchMenu() {
  branchOpen.value = !branchOpen.value;
  if (branchOpen.value && directory.value) fetchBranches(directory.value);
}

// Running sub-agents are easy to lose track of once the transcript scrolls
// past the dispatch, so count them here and jump to the first one on click.
const subagentBadge = computed(() => {
  let count = 0;
  let firstCallID = null;
  for (const child of Object.values(store.childSessions || {})) {
    if (child.status !== "running") continue;
    count += 1;
    if (!firstCallID && child.callID) firstCallID = child.callID;
  }
  return { count, firstCallID };
});

function scrollToRunningSubagent() {
  const id = subagentBadge.value.firstCallID;
  if (!id) return;
  document.getElementById(`tc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
</script>

<template>
  <header>
    <div class="header-left">
      <SshPopover />
      <span class="wordmark" title="radius — OpenCode V2 AI harness">radius</span>

      <span v-if="git && (git.current || git.loading)" class="git-branch">
        <button
          class="git-branch-btn"
          :title="git.error || `Branch: ${git.current}\n${directory}`"
          @click="toggleBranchMenu"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628a2.25 2.25 0 0 1-1.5-2.122ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
          </svg>
          <span>{{ git.current || "…" }}</span>
        </button>
        <div v-if="branchOpen" class="git-branch-menu">
          <div v-if="git.loading && !git.branches.length" class="git-branch-item dim">loading…</div>
          <div v-if="git.error" class="git-branch-item dim">{{ git.error }}</div>
          <div
            v-for="b in git.branches"
            :key="b"
            class="git-branch-item"
            :class="{ current: b === git.current }"
          >
            {{ b }}
          </div>
        </div>
      </span>
    </div>

    <div class="header-title" :title="titleText">
      <span class="header-title-content">
        <span v-if="sessionTitle">{{ sessionTitle }}</span>
        <template v-if="tokenSummary">
          <span v-if="sessionTitle"> · </span>
          <Transition name="token-roll" mode="out-in">
            <span :key="tokenSummaryKey" class="token-summary-value">{{ tokenSummary }}</span>
          </Transition>
        </template>
        <span v-if="contextPercent">{{ sessionTitle || tokenSummary ? " · " : "" }}{{ contextPercent }}</span>
        <span v-if="store.isStreaming" class="dim"> · streaming…</span>
      </span>
    </div>

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
      <ModelFilterPopover />
      <ColorProfilePopover />
    </div>
  </header>
</template>

<style scoped>
</style>

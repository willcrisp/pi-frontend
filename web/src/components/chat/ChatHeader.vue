<!--
  Top chat bar for OpenCode V2: connection indicator, active session title, model label,
  git branch badge/switcher (PTY-backed, localStorage-cached — see stores/git.js), usage popover.
-->
<script setup>
import { computed, ref } from "vue";
import { opencodeStore as store, compactSession } from "../../stores/opencode.js";
import { activeSessionDirectory } from "../../stores/projects.js";
import { gitStore, fetchBranches, checkoutBranch } from "../../stores/git.js";
import ColorProfilePopover from "../popovers/ColorProfilePopover.vue";
import ModelFilterPopover from "../popovers/ModelFilterPopover.vue";
import SshPopover from "../popovers/SshPopover.vue";
import UsagePopover from "../popovers/UsagePopover.vue";

const modelLabel = computed(() => (store.selectedModel ? store.selectedModel.modelID : "OpenCode V2"));
const sessionTitle = computed(() => store.activeSessionId ? `Session ${store.activeSessionId.slice(0, 8)}` : "OpenCode Harness");

const directory = computed(() => activeSessionDirectory());
const git = computed(() => (directory.value ? gitStore.byDirectory[directory.value] : null));
const branchOpen = ref(false);

function toggleBranchMenu() {
  branchOpen.value = !branchOpen.value;
  if (branchOpen.value && directory.value) fetchBranches(directory.value);
}

async function pickBranch(branch) {
  branchOpen.value = false;
  if (!directory.value || !git.value || branch === git.value.current) return;
  try {
    await checkoutBranch(directory.value, branch);
  } catch {
    // error is surfaced via git.error in the badge tooltip
  }
}

// Session menu: currently just "compact context". The V2 HttpApi in this
// build has no session share or fork endpoints, so those menu items are
// removed until the routes land.
const menuOpen = ref(false);
const compacting = ref(false);

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

async function onCompact() {
  compacting.value = true;
  try {
    await compactSession();
  } finally {
    compacting.value = false;
    menuOpen.value = false;
  }
}
</script>

<template>
  <header>
    <div class="header-left">
      <SshPopover />
      <span class="wordmark" title="OpenCode V2 AI Harness">opencode</span>
      <span class="dim">{{ modelLabel }}</span>

      <span v-if="git && (git.current || git.loading)" class="git-branch">
        <button
          class="git-branch-btn"
          :class="{ switching: git.switching }"
          :title="git.error || `Branch: ${git.current}\n${directory}`"
          @click="toggleBranchMenu"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628a2.25 2.25 0 0 1-1.5-2.122ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
          </svg>
          <span>{{ git.switching ? "switching…" : git.current || "…" }}</span>
        </button>
        <div v-if="branchOpen" class="git-branch-menu">
          <div v-if="git.loading && !git.branches.length" class="git-branch-item dim">loading…</div>
          <div v-if="git.error" class="git-branch-item dim">{{ git.error }}</div>
          <button
            v-for="b in git.branches"
            :key="b"
            class="git-branch-item"
            :class="{ current: b === git.current }"
            @click="pickBranch(b)"
          >
            {{ b }}
          </button>
        </div>
      </span>
    </div>

    <div class="header-title">
      <span class="header-title-content">
        <span>{{ sessionTitle }}</span>
        <span v-if="store.isStreaming" class="dim"> · streaming…</span>
      </span>
    </div>

    <div class="header-right">
      <span class="session-menu">
        <button class="icon-btn" title="Session actions" @click="toggleMenu">⋯</button>
        <div v-if="menuOpen" class="session-menu-panel">
          <button class="session-menu-item" :disabled="compacting" @click="onCompact">
            {{ compacting ? "Compacting…" : "Compact context" }}
          </button>
        </div>
      </span>
      <UsagePopover class="header-usage" />
      <ModelFilterPopover />
      <ColorProfilePopover />
    </div>
  </header>
</template>

<style scoped>
.session-menu {
  position: relative;
  display: inline-flex;
}

.session-menu-panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 50;
  min-width: 190px;
  background: var(--panel, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--fg, #ddd);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.session-menu-item:hover:not(:disabled) {
  background: var(--hover, rgba(255, 255, 255, 0.06));
}

.session-menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>

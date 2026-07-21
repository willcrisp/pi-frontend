<!--
  Composer control: click-toggled popover listing the current project's git
  branches (git.js), with a checkmark on the current one. Read-only display
  + refresh only in this component — no checkout UI here (see gitStore's
  checkoutBranch, unused by this file at present). Disabled/shows an error
  when the project directory isn't a git repo.
-->
<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { projectsStore } from "../../stores/projects.js";
import { gitStore, fetchBranches } from "../../stores/git.js";

const root = ref(null);
const open = ref(false);

watch(
  () => projectsStore.currentProjectId,
  (id) => {
    open.value = false;
    if (id) fetchBranches(id);
  },
  { immediate: true }
);

function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false;
}
function onKeydown(e) {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});

const label = computed(() => gitStore.current || (gitStore.loading ? "…" : "no branch"));
</script>

<template>
  <div v-if="projectsStore.currentProjectId" ref="root" class="branch-trigger-wrap">
    <button
      type="button"
      class="branch-trigger"
      :disabled="!gitStore.available"
      :title="gitStore.available ? 'Switch git branch' : gitStore.error || 'Not a git repository'"
      @click="open = !open"
    >
      <svg class="branch-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="4.5" cy="3" r="1.8" stroke="currentColor" stroke-width="1.3" />
        <circle cx="4.5" cy="13" r="1.8" stroke="currentColor" stroke-width="1.3" />
        <circle cx="11.5" cy="6" r="1.8" stroke="currentColor" stroke-width="1.3" />
        <path d="M4.5 4.8V11.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        <path d="M4.5 6.5C4.5 8 5.5 8 6.5 8H8C9.5 8 11.5 8 11.5 7.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <span class="branch-label">{{ label }}</span>
      <svg class="branch-caret" width="8" height="8" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div class="branch-popover-panel" :class="{ open }">
      <div class="branch-head">
        <span class="branch-title">branches</span>
        <button type="button" class="branch-refresh" :disabled="gitStore.loading" @click="fetchBranches(projectsStore.currentProjectId)" title="Refresh">
          {{ gitStore.loading ? "…" : "↻" }}
        </button>
      </div>

      <div v-if="!gitStore.available" class="branch-unavailable usage-dim">
        {{ gitStore.error || "no branches found" }}
      </div>

      <template v-else>
        <div
          v-for="b in gitStore.branches"
          :key="b"
          class="branch-row"
          :class="{ current: b === gitStore.current }"
        >
          <span class="branch-check">{{ b === gitStore.current ? "✓" : "" }}</span>
          <span class="branch-name" :title="b">{{ b }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

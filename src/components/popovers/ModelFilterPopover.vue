<!--
  Header funnel button + checkbox popover for the UI-only model filter.
  Hidden-model state lives in stores/modelfilter.js and is shared with the
  composer's model picker, which drops hidden models from its options.
-->
<script setup>
import { computed, ref } from "vue";
import { opencodeStore as store } from "../../stores/opencode.js";
import { hiddenModels, modelKey, toggleModelHidden } from "../../stores/modelfilter.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const filterOpen = ref(false);

// This popover had no Escape handling at all — it appeared in the composer's old
// ESCAPE_OWNERS list only to stop the key interrupting the run, so it suppressed
// the shortcut while not honouring the contract the shortcuts dialog advertises.
useDialogEscape(() => (filterOpen.value = false), { open: filterOpen });

const allModelsByProvider = computed(() => {
  const groups = new Map();
  for (const m of store.availableModels) {
    const key = m.providerID || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()];
});
</script>

<template>
  <span v-if="store.availableModels.length" class="model-filter header-model-filter">
    <button
      type="button"
      class="model-filter-btn"
      :class="{ active: hiddenModels.size > 0 }"
      :title="hiddenModels.size ? `Model filter (${hiddenModels.size} hidden)` : 'Filter models'"
      @click="filterOpen = !filterOpen"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M2 3h12L9.5 8.8V13l-3-1.5V8.8L2 3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
      </svg>
    </button>
    <div v-if="filterOpen" class="model-filter-menu">
      <div class="model-filter-hint">uncheck to hide from the picker</div>
      <template v-for="[provider, models] in allModelsByProvider" :key="provider">
        <div class="model-filter-provider">{{ provider }}</div>
        <label v-for="m in models" :key="modelKey(m)" class="model-filter-item">
          <input
            type="checkbox"
            :checked="!hiddenModels.has(modelKey(m))"
            @change="toggleModelHidden(m)"
          />
          <span>{{ m.label }}</span>
        </label>
      </template>
    </div>
  </span>
</template>

<!--
  Themed replacement for the native <select> in the composer controls row.
  Native selects render an OS popup that drops *down* and ignores the dark
  theme; this one opens upward (matching the slash menu / branch popover) and
  uses the app's own tokens.

  Options are passed as groups: [{ label, options: [{ value, label, color }] }].
  A group whose label is empty renders without a header.
-->
<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";

const props = defineProps({
  groups: { type: Array, required: true },
  modelValue: { type: String, default: "" },
  title: { type: String, default: "" },
  color: { type: String, default: "" },
  maxWidth: { type: Number, default: 0 },
});
const emit = defineEmits(["update:modelValue"]);

const root = ref(null);
const panel = ref(null);
const open = ref(false);
const activeIndex = ref(-1);

// Flattened option list — the unit both the keyboard nav and the lookup below
// walk over, independent of grouping.
const flat = computed(() => props.groups.flatMap((g) => g.options));

const selected = computed(() => flat.value.find((o) => o.value === props.modelValue) || null);
const label = computed(() => (selected.value ? selected.value.label : ""));

function choose(option) {
  open.value = false;
  if (option.value !== props.modelValue) emit("update:modelValue", option.value);
}

function toggle() {
  open.value = !open.value;
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  activeIndex.value = Math.max(0, flat.value.findIndex((o) => o.value === props.modelValue));
  nextTick(() => {
    panel.value?.querySelector(".select-option.active")?.scrollIntoView({ block: "nearest" });
  });
});

function step(delta) {
  const next = activeIndex.value + delta;
  if (next < 0 || next >= flat.value.length) return;
  activeIndex.value = next;
  nextTick(() => {
    panel.value?.querySelector(".select-option.active")?.scrollIntoView({ block: "nearest" });
  });
}

function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false;
}

function onKeydown(e) {
  if (!open.value) return;
  if (e.key === "Escape") {
    open.value = false;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    step(-1);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    step(1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const option = flat.value[activeIndex.value];
    if (option) choose(option);
  }
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="root" class="select-menu">
    <button
      type="button"
      class="select-trigger"
      :class="{ open }"
      :title="title"
      :style="{ color: color || undefined, maxWidth: maxWidth ? `${maxWidth}px` : undefined }"
      @click="toggle"
    >
      <span class="select-label">{{ label }}</span>
      <svg class="select-caret" width="8" height="8" viewBox="0 0 16 16" fill="none">
        <path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div v-if="open" ref="panel" class="select-panel">
      <div v-for="(group, gi) in groups" :key="group.label || gi" class="select-group">
        <div v-if="group.label" class="select-group-label">{{ group.label }}</div>
        <div
          v-for="option in group.options"
          :key="option.value"
          class="select-option"
          :class="{
            current: option.value === modelValue,
            active: flat.indexOf(option) === activeIndex,
          }"
          :style="{ color: option.color || undefined }"
          :title="option.title || option.label"
          @mouseenter="activeIndex = flat.indexOf(option)"
          @click="choose(option)"
        >
          <span class="select-check">{{ option.value === modelValue ? "✓" : "" }}</span>
          <span class="select-option-label">{{ option.label }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import {
  COLOR_FIELDS,
  colorProfile,
  setColor,
  resetColors,
  fontSize,
  setFontSize,
  thinkingSize,
  setThinkingSize,
  contentWidth,
  setContentWidth,
  CONTENT_WIDTH_MIN,
  CONTENT_WIDTH_MAX,
} from "../../stores/theme.js";

const root = ref(null);
const open = ref(false);

function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) {
    open.value = false;
  }
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
</script>

<template>
  <div ref="root" class="colors-trigger-wrap">
    <button
      type="button"
      class="colors-trigger"
      title="Message colors"
      @click="open = !open"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.5a6.5 6.5 0 0 0 0 13c.9 0 1.4-.7 1.4-1.4 0-.4-.2-.7-.4-1-.2-.2-.4-.5-.4-.9 0-.6.5-1.1 1.1-1.1h1.3A3.5 3.5 0 0 0 14.5 6.6C14.5 3.8 11.6 1.5 8 1.5Z"
          stroke="currentColor"
          stroke-width="1.1"
        />
        <circle cx="5" cy="6" r="1" fill="currentColor" />
        <circle cx="8" cy="4.5" r="1" fill="currentColor" />
        <circle cx="11" cy="6" r="1" fill="currentColor" />
      </svg>
    </button>

    <div class="colors-popover-panel" :class="{ open }">
      <div class="colors-head">
        <span class="colors-title">message colors</span>
        <button type="button" class="colors-reset" @click="resetColors">reset</button>
      </div>

      <label v-for="f in COLOR_FIELDS" :key="f.key" class="colors-row">
        <span class="colors-swatch" :style="{ background: colorProfile[f.key] }"></span>
        <span class="colors-label">{{ f.label }}</span>
        <input
          type="color"
          class="colors-input"
          :value="colorProfile[f.key]"
          @input="setColor(f.key, $event.target.value)"
        />
      </label>

      <div class="colors-divider"></div>

      <div class="colors-row font-size-row">
        <span class="colors-label">font size</span>
        <div class="font-size-control">
          <button
            type="button"
            class="font-size-btn"
            title="Decrease font size"
            @click="setFontSize(fontSize.px - 1)"
          >−</button>
          <span class="font-size-value">{{ fontSize.px }}</span>
          <button
            type="button"
            class="font-size-btn"
            title="Increase font size"
            @click="setFontSize(fontSize.px + 1)"
          >+</button>
        </div>
      </div>

      <div class="colors-divider"></div>

      <div class="colors-row font-size-row">
        <span class="colors-label">thinking size</span>
        <div class="font-size-control">
          <button
            type="button"
            class="font-size-btn"
            title="Decrease thinking text size"
            @click="setThinkingSize(thinkingSize.percent - 5)"
          >−</button>
          <span class="font-size-value">{{ thinkingSize.percent }}%</span>
          <button
            type="button"
            class="font-size-btn"
            title="Increase thinking text size"
            @click="setThinkingSize(thinkingSize.percent + 5)"
          >+</button>
        </div>
      </div>

      <div class="colors-divider"></div>

      <div class="colors-row font-size-row">
        <span class="colors-label">content width</span>
        <div class="font-size-control">
          <button
            type="button"
            class="font-size-btn"
            title="Decrease content width"
            @click="setContentWidth(contentWidth.px - 20)"
          >−</button>
          <input
            type="number"
            class="content-width-value"
            :min="CONTENT_WIDTH_MIN"
            :max="CONTENT_WIDTH_MAX"
            :value="contentWidth.px"
            @change="setContentWidth(Number($event.target.value))"
          />
          <button
            type="button"
            class="font-size-btn"
            title="Increase content width"
            @click="setContentWidth(contentWidth.px + 20)"
          >+</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from "vue";

// Pure fidget toy: a low-poly d20 that tumbles in place and lands on a random
// face. No app state involved — everything is local to this component.
const face = ref(20);
const rolling = ref(false);
const flair = ref(""); // "" | "crit" (nat 20) | "fumble" (nat 1)
const rollCount = ref(0); // keys the svg wrapper so rapid re-clicks restart the spin
let tumbleTimer = null;
let settleTimer = null;

const ROLL_MS = 900;

function roll() {
  clearInterval(tumbleTimer);
  clearTimeout(settleTimer);
  flair.value = "";
  rolling.value = true;
  rollCount.value++;
  tumbleTimer = setInterval(() => {
    face.value = 1 + Math.floor(Math.random() * 20);
  }, 75);
  settleTimer = setTimeout(() => {
    clearInterval(tumbleTimer);
    face.value = 1 + Math.floor(Math.random() * 20);
    rolling.value = false;
    flair.value = face.value === 20 ? "crit" : face.value === 1 ? "fumble" : "";
  }, ROLL_MS);
}

onBeforeUnmount(() => {
  clearInterval(tumbleTimer);
  clearTimeout(settleTimer);
});
</script>

<template>
  <button
    type="button"
    class="d20-btn"
    :aria-label="rolling ? 'Rolling the d20…' : `Roll the d20 (last roll: ${face})`"
    :title="
      rolling
        ? 'Rolling…'
        : flair === 'crit'
          ? 'Natural 20!'
          : flair === 'fumble'
            ? 'Ouch, a 1. Roll again?'
            : `Rolled ${face} — click to roll`
    "
    @click="roll"
  >
    <span
      :key="rollCount"
      class="d20"
      :class="{ rolling, crit: flair === 'crit', fumble: flair === 'fumble' }"
    >
      <!--
        Face-on projection of an icosahedron: hexagonal silhouette, central
        downward face, nine surrounding facets shaded by fill-opacity.
      -->
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <g stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="currentColor">
          <polygon fill-opacity="0.22" points="27,33 73,33 50,3" />
          <polygon fill-opacity="0.14" points="27,33 50,3 9.3,26.5" />
          <polygon fill-opacity="0.18" points="73,33 50,3 90.7,26.5" />
          <polygon fill-opacity="0.06" points="27,33 9.3,26.5 9.3,73.5" />
          <polygon fill-opacity="0.12" points="73,33 90.7,26.5 90.7,73.5" />
          <polygon fill-opacity="0.1" points="27,33 9.3,73.5 50,72" />
          <polygon fill-opacity="0.16" points="73,33 50,72 90.7,73.5" />
          <polygon fill-opacity="0.05" points="50,72 9.3,73.5 50,97" />
          <polygon fill-opacity="0.09" points="50,72 50,97 90.7,73.5" />
          <polygon fill-opacity="0.3" points="27,33 73,33 50,72" />
        </g>
        <text class="d20-num" x="50" y="46" text-anchor="middle" dominant-baseline="central">
          {{ face }}
        </text>
      </svg>
    </span>
  </button>
</template>

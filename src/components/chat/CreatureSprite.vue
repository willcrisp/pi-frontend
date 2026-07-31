<!--
  One creature, drawn as pixels.

  SVG rects rather than a canvas: it stays crisp at any size (the same genome is
  drawn at 14px in the header and 96px in the menagerie), it needs no devicePixel
  handling, and it can be styled and animated from CSS. A 16×16 grid is at most
  256 rects and typically well under half that — cheap enough to render a whole
  menagerie of them.

  The grid comes from lib/creature.js and is purely a function of the genome, so
  this component holds no state and never needs to invalidate anything.
-->
<script setup>
import { computed } from "vue";
import { SPRITE_SIZE, eggSprite, spriteFor } from "../../lib/creature.js";

const props = defineProps({
  genome: { type: Object, required: true },
  size: { type: Number, default: 16 },
  // Eggs about to hatch crack; pass the progress so the shell can show it.
  progress: { type: Number, default: 0 },
});

const sprite = computed(() =>
  props.genome.lineage?.length ? spriteFor(props.genome) : eggSprite(props.progress)
);

// Flattened to a list of drawable cells so the template does no arithmetic.
const cells = computed(() => {
  const out = [];
  const { grid, palette } = sprite.value;
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    out.push({
      key: i,
      x: i % SPRITE_SIZE,
      y: Math.floor(i / SPRITE_SIZE),
      fill: palette[grid[i]] || palette[1],
    });
  }
  return out;
});
</script>

<template>
  <svg
    class="creature-sprite"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}`"
    role="img"
    :aria-label="genome.name || 'unhatched egg'"
  >
    <rect v-for="c in cells" :key="c.key" :x="c.x" :y="c.y" width="1" height="1" :fill="c.fill" />
  </svg>
</template>

<style scoped>
/* Pixels, not a smoothed image — without this the browser antialiases the rect
   edges and the whole thing turns to mush at small sizes. */
.creature-sprite {
  shape-rendering: crispEdges;
  display: block;
  flex: none;
}
</style>

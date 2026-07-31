<!--
  One creature, drawn as isometric voxels.

  The pipeline, each step in its own file: the genome names a part per slot
  (lib/creature.js), the parts library turns those names into a voxel volume
  (lib/creatureparts.js), the projector culls the hidden faces and flattens what
  is left into polygons (lib/voxel.js), and this component paints them.

  SVG polygons rather than a canvas: the same genome renders crisply at 16px in
  the header and 96px in the menagerie with one geometry pass, there is no
  devicePixelRatio handling, and it can be styled from CSS. Hidden-face culling
  keeps a typical creature to roughly 150 polygons.

  No state, no lifecycle: everything here is a pure function of the genome, so
  there is nothing to invalidate.
-->
<script setup>
import { computed } from "vue";
import { composeCreature } from "../../lib/creatureparts.js";
import { project, shade } from "../../lib/voxel.js";

const props = defineProps({
  genome: { type: Object, required: true },
  size: { type: Number, default: 16 },
  // Eggs crack as they approach hatching; pass the progress so the shell shows
  // it. Ignored once there is a lineage to draw.
  progress: { type: Number, default: 0 },
});

const model = computed(() => {
  const { voxels, palette } = composeCreature(props.genome, { progress: props.progress });
  const { faces, viewBox } = project(voxels);
  return {
    viewBox,
    faces: faces.map((f, i) => ({
      key: i,
      points: f.points,
      fill: shade(palette[f.slot] || palette[1], f.face),
    })),
  };
});
</script>

<template>
  <svg
    class="creature-sprite"
    :width="size"
    :height="size"
    :viewBox="model.viewBox"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    :aria-label="genome.name || 'unhatched egg'"
  >
    <polygon v-for="f in model.faces" :key="f.key" :points="f.points" :fill="f.fill" />
  </svg>
</template>

<style scoped>
/* Voxels, not a smoothed render. Every vertex the projection emits is on a whole
   unit (see lib/voxel.js), so with this the cube edges stay hard at any size —
   which is the difference between voxel pixel art and a blurry 3D thumbnail. */
.creature-sprite {
  shape-rendering: crispEdges;
  display: block;
  flex: none;
  overflow: visible;
}
</style>

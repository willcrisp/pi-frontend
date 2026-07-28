<!--
  Modal for marking up a pasted/dropped image before it's sent as an attachment.
  Freehand red marker only: drag to draw, Ctrl/Cmd+Z undoes the last stroke,
  Save flattens the strokes into the image and hands back a PNG data URL,
  Cancel/Escape/backdrop discards them.

  Strokes are kept as point lists in *image* pixel coordinates and the whole
  canvas is redrawn from scratch on every change, so undo is a pop and the
  saved PNG is always at the image's natural resolution no matter how much the
  canvas was scaled down to fit the viewport.
-->
<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  src: { type: String, required: true },
  filename: { type: String, default: "" },
});

const emit = defineEmits(["save", "cancel"]);

const canvasEl = ref(null);
const loading = ref(true);
const error = ref("");
const strokes = ref([]);

let image = null;
let drawing = null; // the stroke in progress, or null

// Marker width scales with the image so a 4K screenshot doesn't get hairlines.
function markerWidth() {
  if (!image) return 3;
  return Math.max(2, Math.round(Math.max(image.naturalWidth, image.naturalHeight) / 300));
}

function redraw() {
  const canvas = canvasEl.value;
  if (!canvas || !image) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  ctx.strokeStyle = "#ff2d2d";
  ctx.lineWidth = markerWidth();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of strokes.value) {
    if (!stroke.length) continue;
    ctx.beginPath();
    if (stroke.length === 1) {
      // A tap with no movement still leaves a dot.
      ctx.arc(stroke[0].x, stroke[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = "#ff2d2d";
      ctx.fill();
      continue;
    }
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

// Canvas is displayed scaled-to-fit, so map client coords back to image pixels.
function pointFromEvent(e) {
  const canvas = canvasEl.value;
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function onPointerDown(e) {
  if (loading.value || e.button !== 0) return;
  canvasEl.value.setPointerCapture(e.pointerId);
  drawing = [pointFromEvent(e)];
  strokes.value.push(drawing);
  redraw();
}

function onPointerMove(e) {
  if (!drawing) return;
  drawing.push(pointFromEvent(e));
  redraw();
}

function onPointerUp() {
  drawing = null;
}

function undo() {
  strokes.value.pop();
  redraw();
}

function clearAll() {
  strokes.value = [];
  redraw();
}

function save() {
  if (!canvasEl.value) return;
  emit("save", canvasEl.value.toDataURL("image/png"));
}

function onKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) emit("cancel");
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  image = new Image();
  image.onload = () => {
    const canvas = canvasEl.value;
    if (!canvas) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    loading.value = false;
    redraw();
  };
  image.onerror = () => {
    loading.value = false;
    error.value = "Could not load this image for editing.";
  };
  image.src = props.src;
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel annotator-panel" @mousedown.stop>
      <div class="connect-head">
        <span>{{ filename || "Annotate image" }}</span>
        <button class="connect-close" title="Close (Esc)" @click="emit('cancel')">✕</button>
      </div>

      <div class="annotator-stage">
        <p v-if="error" class="annotator-error">{{ error }}</p>
        <canvas
          v-show="!error"
          ref="canvasEl"
          class="annotator-canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        ></canvas>
      </div>

      <div class="connect-actions annotator-actions">
        <button type="button" :disabled="!strokes.length || !!error" @click="save">Save</button>
        <button type="button" class="connect-secondary" @click="emit('cancel')">Cancel</button>
        <span class="annotator-spacer"></span>
        <button
          type="button"
          class="connect-secondary"
          title="Undo last stroke (Ctrl/Cmd+Z)"
          :disabled="!strokes.length"
          @click="undo"
        >
          Undo
        </button>
        <button
          type="button"
          class="connect-secondary"
          :disabled="!strokes.length"
          @click="clearAll"
        >
          Clear
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.annotator-panel {
  width: min(920px, 92vw);
  max-width: none;
}

.annotator-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: #0b0d10;
  border: 1px solid var(--border);
  border-radius: 6px;
  min-height: 120px;
}

.annotator-canvas {
  max-width: 100%;
  max-height: 62vh;
  cursor: crosshair;
  touch-action: none;
}

.annotator-error {
  margin: 0;
  color: var(--dim);
  font-size: 13px;
}

.annotator-actions {
  align-items: center;
}

.annotator-spacer {
  flex: 1;
}
</style>

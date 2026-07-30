<!--
  The work profile: what KIND of work you have been doing, drawn as a radar over
  the eight categories in lib/workcategories.js.

  The radar is the shape of the thing — it answers "am I lopsided?" at a glance
  and nothing else does. It is deliberately NOT the only reading on screen: a
  polygon is bad at precise comparison, so every axis is also a labelled bar
  below it, which doubles as the table view for anyone the chart doesn't serve.

  Three ways to fill it in, in ascending order of cost, all explained in
  stores/workprofile.js: session titles (free), transcripts (a request each), or
  a model (tokens, opt-in). The panel always says which one the shape rests on,
  because "we read your titles" and "a model read your work" deserve very
  different amounts of trust and they draw exactly the same polygon.
-->
<script setup>
import { computed, ref } from "vue";
import {
  classifyWithModel,
  compareScope,
  profileScope,
  scanTranscripts,
  setWeight,
  weakSessions,
  workProfileStore,
} from "../../stores/workprofile.js";
import { CATEGORIES, categoryLabel } from "../../lib/workcategories.js";
import { directoryLabel, projectsStore } from "../../stores/projects.js";
import { opencodeStore } from "../../stores/opencode.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const emit = defineEmits(["close"]);

// Two series, and only ever two — validated for dark-surface separation and CVD
// (OKLab ΔE 26.8 normal / 23.1 protan against #121517). Every other mark on the
// chart is grid or ink: the categories are identified by their axis labels, not
// by colour, so nothing here needs an eight-hue palette to be read.
const SERIES_ALL = "#4f86e0";
const SERIES_ONE = "#cf7a45";

const RANGES = [
  { days: 0, label: "All time" },
  { days: 30, label: "30 days" },
  { days: 7, label: "7 days" },
];

// All time by default. A recent window reads better once there is a habit to
// look at, but someone opening this after a quiet fortnight would get an empty
// radar and conclude the feature is broken — the same failure the usage view's
// $0.00 note exists to prevent.
const range = ref(0);
const directory = ref("");

// Only projects with sessions, most recent first — the same order the sidebar
// groups in, so the two lists agree.
const projects = computed(() => {
  const seen = new Map();
  for (const s of projectsStore.sessions || []) {
    if (s.parentID || seen.has(s.directory)) continue;
    seen.set(s.directory, directoryLabel(s.directory));
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
});

const scope = computed(() => profileScope({ directory: directory.value, days: range.value }));

const activeDirectory = computed(() => {
  const id = opencodeStore.activeSessionId;
  return (projectsStore.sessions || []).find((s) => s.id === id)?.directory || "";
});

// The overlay: the project you are in against everything, so "I do a lot of
// frontend" can be checked against "…but not here". Suppressed when the scope IS
// one project already (the two polygons would be identical) and when there is
// only one project to draw (compareScope returns null).
const compare = computed(() => (directory.value ? null : compareScope(activeDirectory.value)));

const compareLabel = computed(() => directoryLabel(activeDirectory.value));

// --- Geometry ---------------------------------------------------------------

const SIZE = 260;
const CENTRE = SIZE / 2;
const RADIUS = 88;
const RINGS = 4;

const axes = computed(() =>
  CATEGORIES.map((c, i) => {
    // First spoke straight up, then clockwise — the order in CATEGORIES, which
    // is fixed, so an axis never moves between two renders of the same data.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / CATEGORIES.length;
    return { ...c, angle, cos: Math.cos(angle), sin: Math.sin(angle) };
  })
);

// Both polygons share one scale, set by the biggest value on either of them —
// otherwise the overlay would be drawn to a different ruler than the thing it is
// being compared against, which is the whole point of drawing it.
const peak = computed(() => {
  const values = [];
  for (const c of CATEGORIES) {
    values.push(scope.value.aggregate.scores[c.id] || 0);
    if (compare.value) values.push(compare.value.aggregate.scores[c.id] || 0);
  }
  return Math.max(...values, 0.0001);
});

function point(index, value) {
  const axis = axes.value[index];
  const r = RADIUS * Math.min(value / peak.value, 1);
  return [CENTRE + axis.cos * r, CENTRE + axis.sin * r];
}

function polygon(scores) {
  return CATEGORIES.map((c, i) => point(i, scores[c.id] || 0).map((n) => n.toFixed(1)).join(","))
    .join(" ");
}

function ringPoints(step) {
  const r = (RADIUS * step) / RINGS;
  return axes.value
    .map((a) => `${(CENTRE + a.cos * r).toFixed(1)},${(CENTRE + a.sin * r).toFixed(1)}`)
    .join(" ");
}

// Label placement: outside the outermost ring, anchored so a long word grows
// away from the chart rather than across it.
function labelFor(index) {
  const axis = axes.value[index];
  const r = RADIUS + 16;
  const x = CENTRE + axis.cos * r;
  const y = CENTRE + axis.sin * r;
  const anchor = Math.abs(axis.cos) < 0.2 ? "middle" : axis.cos > 0 ? "start" : "end";
  return { x, y: y + (Math.abs(axis.sin) > 0.9 ? (axis.sin > 0 ? 8 : -2) : 3), anchor };
}

const mainPolygon = computed(() => polygon(scope.value.aggregate.scores));
const comparePolygon = computed(() =>
  compare.value ? polygon(compare.value.aggregate.scores) : ""
);

const hasShape = computed(() => scope.value.aggregate.total > 0);

// --- The ranked reading ------------------------------------------------------

const ranked = computed(() =>
  CATEGORIES.map((c) => ({
    ...c,
    share: scope.value.aggregate.scores[c.id] || 0,
    compare: compare.value ? compare.value.aggregate.scores[c.id] || 0 : null,
  })).sort((a, b) => b.share - a.share)
);

function percent(v) {
  if (!v) return "0%";
  return `${(v * 100).toFixed(v < 0.095 ? 1 : 0)}%`;
}

function barWidth(v) {
  return `${Math.min((v / peak.value) * 100, 100).toFixed(1)}%`;
}

// --- Filling it in -----------------------------------------------------------

const scanState = computed(() => workProfileStore.scan);
const modelState = computed(() => workProfileStore.model);

const unscanned = computed(() =>
  scope.value.entries.filter((e) => e.source === "title").map((e) => e.sessionID)
);
const weak = computed(() => weakSessions(scope.value.entries));

function onScan() {
  const ids = unscanned.value.length
    ? unscanned.value
    : scope.value.entries.map((e) => e.sessionID);
  scanTranscripts(ids, { force: !unscanned.value.length });
}

function onModel() {
  classifyWithModel(weak.value.slice(0, 20));
}

const SOURCE_LABEL = {
  title: "title only",
  transcript: "transcript",
  model: "model",
  live: "transcript",
};

function sessionChips(entry) {
  return CATEGORIES.map((c) => ({ id: c.id, label: c.label, share: entry.scores[c.id] || 0 }))
    .filter((c) => c.share > 0.12)
    .sort((a, b) => b.share - a.share)
    .slice(0, 3);
}

const { onBackdrop } = useDialogEscape(() => emit("close"));
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Work profile</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <div class="wp-controls">
        <select v-model="directory" class="connect-filter" aria-label="Project">
          <option value="">All projects</option>
          <option v-for="p in projects" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <select v-model.number="range" class="connect-filter" aria-label="Time range">
          <option v-for="r in RANGES" :key="r.days" :value="r.days">{{ r.label }}</option>
        </select>
        <div class="wp-toggle" role="group" aria-label="Weighting">
          <button
            type="button"
            :class="{ on: workProfileStore.weight === 'tokens' }"
            title="Weight each session by the tokens it spent"
            @click="setWeight('tokens')"
          >
            by tokens
          </button>
          <button
            type="button"
            :class="{ on: workProfileStore.weight === 'sessions' }"
            title="Weight every session equally"
            @click="setWeight('sessions')"
          >
            by session
          </button>
        </div>
      </div>

      <p v-if="!hasShape" class="connect-hint">
        Nothing classified in this range yet. Scan the transcripts below — reading what the
        tools touched is what turns a session into a category.
      </p>

      <template v-else>
        <div class="wp-chart">
          <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="wp-radar" role="img"
               :aria-label="`Work split across ${CATEGORIES.length} categories; the ranked list below carries the same figures`">
            <!-- Grid: rings first, then spokes, so data always sits on top. -->
            <polygon
              v-for="step in RINGS"
              :key="`ring-${step}`"
              :points="ringPoints(step)"
              class="wp-ring"
            />
            <line
              v-for="a in axes"
              :key="`spoke-${a.id}`"
              :x1="CENTRE"
              :y1="CENTRE"
              :x2="CENTRE + a.cos * RADIUS"
              :y2="CENTRE + a.sin * RADIUS"
              class="wp-spoke"
            />

            <polygon
              v-if="comparePolygon"
              :points="comparePolygon"
              class="wp-shape"
              :style="{ fill: SERIES_ONE, stroke: SERIES_ONE }"
            />
            <polygon
              :points="mainPolygon"
              class="wp-shape"
              :style="{ fill: SERIES_ALL, stroke: SERIES_ALL }"
            />

            <!-- Vertices double as the hover target: the marker is 8px, the hit
                 circle behind it is 20px, per the usual "target bigger than the
                 mark" rule for anything this small. -->
            <g v-for="(c, i) in CATEGORIES" :key="`v-${c.id}`">
              <circle
                :cx="point(i, scope.aggregate.scores[c.id] || 0)[0]"
                :cy="point(i, scope.aggregate.scores[c.id] || 0)[1]"
                r="4"
                :style="{ fill: SERIES_ALL }"
                class="wp-vertex"
              />
              <circle
                :cx="point(i, scope.aggregate.scores[c.id] || 0)[0]"
                :cy="point(i, scope.aggregate.scores[c.id] || 0)[1]"
                r="10"
                class="wp-hit"
              >
                <title>{{ c.label }} — {{ percent(scope.aggregate.scores[c.id] || 0) }}</title>
              </circle>
            </g>

            <text
              v-for="(c, i) in CATEGORIES"
              :key="`l-${c.id}`"
              :x="labelFor(i).x"
              :y="labelFor(i).y"
              :text-anchor="labelFor(i).anchor"
              class="wp-axis-label"
            >
              {{ c.label }}
            </text>
          </svg>

          <div class="wp-side">
            <div class="wp-legend">
              <span class="wp-key">
                <span class="wp-swatch" :style="{ background: SERIES_ALL }"></span>
                {{ directory ? directoryLabel(directory) : "All work" }}
              </span>
              <span v-if="compare" class="wp-key">
                <span class="wp-swatch" :style="{ background: SERIES_ONE }"></span>
                {{ compareLabel }}
              </span>
            </div>

            <!-- A radar with no scale is a shape you can't read a number off,
                 so say what the outer ring is worth. The bars carry the exact
                 figures; this is what makes the polygon itself legible. -->
            <p class="wp-scale">outer ring = {{ percent(peak) }}</p>

            <ul class="wp-bars">
              <li v-for="row in ranked" :key="row.id" :title="row.hint">
                <span class="wp-bar-label">{{ row.label }}</span>
                <span class="wp-bar-track">
                  <span
                    class="wp-bar-fill"
                    :style="{ width: barWidth(row.share), background: SERIES_ALL }"
                  ></span>
                  <span
                    v-if="row.compare !== null"
                    class="wp-bar-compare"
                    :style="{ width: barWidth(row.compare), background: SERIES_ONE }"
                  ></span>
                </span>
                <span class="wp-bar-value">{{ percent(row.share) }}</span>
              </li>
            </ul>
          </div>
        </div>

        <p class="connect-hint">
          {{ scope.classified }} of {{ scope.entries.length }} session{{
            scope.entries.length === 1 ? "" : "s"
          }}
          classified, weighted {{ scope.weightedBy === "tokens" ? "by tokens spent" : "one per session" }}.
          <template v-if="scope.titleOnly">
            {{ scope.titleOnly === scope.entries.length ? "All of them rest" : `${scope.titleOnly} of
            them rest` }} on the session title alone.
          </template>
        </p>
      </template>

      <div class="wp-actions">
        <button type="button" :disabled="scanState.busy" @click="onScan">
          {{
            scanState.busy
              ? `scanning ${scanState.done}/${scanState.total}…`
              : unscanned.length
                ? `Scan ${unscanned.length} transcript${unscanned.length === 1 ? "" : "s"}`
                : "Rescan transcripts"
          }}
        </button>
        <button
          type="button"
          :disabled="modelState.busy || !weak.length"
          :title="
            weak.length
              ? `Sends a short digest of ${weak.length} unclear session${weak.length === 1 ? '' : 's'} to your model. Costs tokens.`
              : 'Nothing left that the transcript scan couldn\'t call'
          "
          @click="onModel"
        >
          {{
            modelState.busy
              ? `asking the model ${modelState.done}/${modelState.total}…`
              : weak.length
                ? `Ask the model about ${weak.length} unclear`
                : "Nothing unclear left"
          }}
        </button>
      </div>

      <p class="connect-hint">
        Scanning reads each session's transcript — the files its tools touched are the strongest
        signal there is. The model pass is the fallback for what that still can't call: it spends
        tokens, and runs in one reused hidden session rather than littering your sidebar.
      </p>

      <p v-if="scanState.error" class="connect-error">{{ scanState.error }}</p>
      <p v-if="modelState.error" class="connect-error">{{ modelState.error }}</p>

      <template v-if="scope.entries.length">
        <div class="connect-head" style="margin-top: 14px"><span>Sessions</span></div>
        <ul class="agents-list">
          <li v-for="entry in scope.entries" :key="entry.sessionID" class="agents-row">
            <div class="agents-row-main">
              <span class="agents-name">{{ entry.title }}</span>
              <span class="agents-desc">
                <template v-if="entry.top">
                  <span v-for="chip in sessionChips(entry)" :key="chip.id" class="wp-chip">
                    {{ chip.label }} {{ percent(chip.share) }}
                  </span>
                </template>
                <span v-else class="wp-chip dim">unclassified</span>
              </span>
            </div>
            <div class="agents-row-meta">
              <span class="wp-source" :class="entry.source">{{ SOURCE_LABEL[entry.source] }}</span>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wp-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 4px;
}

.wp-controls .connect-filter {
  flex: 1 1 120px;
  min-width: 0;
}

.wp-toggle {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  flex: none;
}

.wp-toggle button {
  border: 0;
  background: transparent;
  color: var(--dim);
  font: inherit;
  font-size: 11px;
  padding: 5px 8px;
  cursor: pointer;
}

.wp-toggle button.on {
  background: var(--bg-raised);
  color: var(--fg);
}

.wp-chart {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-top: 10px;
  flex: none;
}

/* `flex: none` for the same reason the usage chart needs it: .connect-panel is a
   flex column, and a shrunk SVG box takes every percentage inside it to zero. */
.wp-radar {
  width: 260px;
  height: 260px;
  flex: none;
  overflow: visible;
}

.wp-ring,
.wp-spoke {
  fill: none;
  stroke: var(--border);
  stroke-width: 1;
}

.wp-ring {
  stroke-dasharray: 2 3;
}

.wp-shape {
  fill-opacity: 0.16;
  stroke-width: 2;
  stroke-linejoin: round;
}

.wp-vertex {
  stroke: var(--bg-raised);
  stroke-width: 2;
}

/* Bigger than the mark, invisible, and the thing that actually carries the
   tooltip. */
.wp-hit {
  fill: transparent;
}

.wp-axis-label {
  fill: var(--dim);
  font-size: 10px;
  font-family: inherit;
}

.wp-side {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wp-legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dim);
}

.wp-key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.wp-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
}

.wp-scale {
  font-size: 10px;
  color: var(--dim);
  margin-top: -4px;
}

.wp-bars {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wp-bars li {
  display: grid;
  grid-template-columns: 62px 1fr 34px;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--dim);
}

.wp-bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-bar-track {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wp-bar-fill,
.wp-bar-compare {
  height: 6px;
  border-radius: 0 3px 3px 0;
  min-width: 1px;
}

.wp-bar-compare {
  height: 3px;
  opacity: 0.9;
}

.wp-bar-value {
  text-align: right;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.wp-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.wp-chip {
  display: inline-block;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 6px;
  margin-right: 4px;
  font-size: 10px;
  line-height: 16px;
}

.wp-chip.dim {
  opacity: 0.6;
}

.wp-source {
  font-size: 10px;
  color: var(--dim);
}

.wp-source.model {
  color: var(--accent);
}

@media (max-width: 640px) {
  .wp-chart {
    flex-direction: column;
    align-items: stretch;
  }

  .wp-radar {
    align-self: center;
  }
}
</style>

<!--
  Usage history. The hover popover (UsagePopover.vue) keeps its job — live stats
  for the session on screen — and this dialog answers the questions it has no
  room for: what has been spent over time, on which projects, on which models.

  Local totals come free from the session list already in memory. Gateway totals
  are opt-in behind a PAT, because they cost a PTY round-trip and only exist for
  a configured TrueFoundry tenant.
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import { localUsage, hasUnpricedModels, usageStore, refreshGatewayUsage } from "../../stores/usage.js";
import { providersStore, loadEnvPAT } from "../../stores/providers.js";
import { readString } from "../../lib/storage.js";
import {
  DEFAULT_TRUEFOUNDRY_GATEWAY,
  TRUEFOUNDRY_GATEWAY_KEY,
} from "../../lib/truefoundry.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const emit = defineEmits(["close"]);

const usage = computed(() => localUsage());
const gateway = computed(() => usageStore.gateway);

const tfGateway = ref(readString(TRUEFOUNDRY_GATEWAY_KEY, DEFAULT_TRUEFOUNDRY_GATEWAY));
const tfPAT = ref("");

// Same read-through as the Integrations card: a token already in the host's
// .env means this panel works without typing one here either.
onMounted(loadEnvPAT);
const envPATSource = computed(() => providersStore.trueFoundry.envPATSource);
const hasPAT = computed(() => Boolean(tfPAT.value.trim() || envPATSource.value));

// Bars are drawn relative to the busiest day, so a quiet week still reads.
const maxDayCost = computed(() =>
  Math.max(...usage.value.byDay.map((d) => d.cost || 0), 0.000001)
);
const maxDayTokens = computed(() =>
  Math.max(...usage.value.byDay.map((d) => d.tokens || 0), 1)
);

// Cost is the better signal, but it's identically 0 for an unpriced provider —
// in which case the chart falls back to tokens rather than drawing a flat line.
const chartByCost = computed(() => usage.value.cost > 0);

function barHeight(day) {
  const pct = chartByCost.value
    ? (day.cost / maxDayCost.value) * 100
    : (day.tokens / maxDayTokens.value) * 100;
  return `${Math.max(pct, 2)}%`;
}

async function onLoadGateway() {
  await refreshGatewayUsage(tfGateway.value, tfPAT.value.trim(), { force: true });
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n) {
  if (n == null) return "—";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function shortDay(day) {
  return day.slice(5); // MM-DD
}

const { onBackdrop } = useDialogEscape(() => emit("close"));
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Usage</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <div class="usage-tiles">
        <div class="usage-tile">
          <span class="usage-tile-label">Total cost</span>
          <strong class="usage-tile-value">{{ formatCost(usage.cost) }}</strong>
        </div>
        <div class="usage-tile">
          <span class="usage-tile-label">Total tokens</span>
          <strong class="usage-tile-value">{{ formatTokens(usage.tokens) }}</strong>
        </div>
        <div class="usage-tile">
          <span class="usage-tile-label">Sessions</span>
          <strong class="usage-tile-value">{{ usage.sessions }}</strong>
        </div>
      </div>

      <!-- Without this note a tenant user sees $0.00 and concludes the feature is
           broken, when in fact OpenCode has no pricing to compute against. -->
      <p v-if="hasUnpricedModels() && usage.cost === 0" class="connect-hint">
        TrueFoundry models report no cost to OpenCode, so local totals show tokens only. Load
        gateway usage below for real spend.
      </p>

      <template v-if="usage.byDay.length">
        <div class="connect-head" style="margin-top: 14px">
          <span>{{ chartByCost ? "Cost" : "Tokens" }} by day</span>
        </div>
        <div class="usage-chart">
          <div
            v-for="day in usage.byDay"
            :key="day.day"
            class="usage-bar-slot"
            :title="`${day.day} · ${formatCost(day.cost)} · ${formatTokens(day.tokens)} tokens`"
          >
            <div class="usage-bar" :style="{ height: barHeight(day) }"></div>
            <span class="usage-bar-label">{{ shortDay(day.day) }}</span>
          </div>
        </div>
      </template>

      <template v-if="usage.byProject.length">
        <div class="connect-head" style="margin-top: 14px">
          <span>By project</span>
        </div>
        <ul class="agents-list">
          <li v-for="p in usage.byProject" :key="p.directory" class="agents-row">
            <div class="agents-row-main">
              <span class="agents-name">{{ p.label }}</span>
              <span class="agents-desc">{{ p.sessions }} session{{ p.sessions === 1 ? "" : "s" }}</span>
            </div>
            <div class="agents-row-meta">
              <span>{{ formatCost(p.cost) }}</span>
              <span class="usage-dim">{{ formatTokens(p.tokens) }}</span>
            </div>
          </li>
        </ul>
      </template>

      <template v-if="usage.top.length">
        <div class="connect-head" style="margin-top: 14px">
          <span>Most expensive sessions</span>
        </div>
        <ul class="agents-list">
          <li v-for="s in usage.top" :key="s.id" class="agents-row">
            <div class="agents-row-main">
              <span class="agents-name">{{ s.title }}</span>
            </div>
            <div class="agents-row-meta">
              <span>{{ formatCost(s.cost) }}</span>
              <span class="usage-dim">{{ formatTokens(s.tokens) }}</span>
            </div>
          </li>
        </ul>
      </template>

      <div class="connect-head" style="margin-top: 16px">
        <span>Gateway usage</span>
      </div>
      <p class="connect-hint">
        Queries your TrueFoundry gateway for authoritative cost. Runs on the OpenCode host; the
        token is not stored.
      </p>
      <form class="add-project-form" @submit.prevent="onLoadGateway">
        <input
          v-model="tfGateway"
          type="url"
          class="connect-filter"
          placeholder="https://gateway.example.com"
          autocomplete="off"
        />
        <input
          v-model="tfPAT"
          type="password"
          class="connect-filter"
          :placeholder="envPATSource ? 'Using token from .env' : 'Personal access token'"
          autocomplete="off"
        />
        <button type="submit" :disabled="gateway.busy || !hasPAT">
          {{ gateway.busy ? "loading…" : "Load" }}
        </button>
      </form>

      <p v-if="envPATSource" class="connect-hint">
        Using <code>{{ envPATSource.key }}</code> from <code>{{ envPATSource.path }}</code>.
      </p>

      <p v-if="gateway.error" class="connect-error">{{ gateway.error }}</p>

      <ul v-if="gateway.byModel.length" class="agents-list">
        <li v-for="row in gateway.byModel" :key="row.model" class="agents-row">
          <div class="agents-row-main">
            <span class="agents-name">{{ row.model }}</span>
            <span class="agents-desc">{{ row.requests }} request{{ row.requests === 1 ? "" : "s" }}</span>
          </div>
          <div class="agents-row-meta">
            <span>{{ formatCost(row.cost) }}</span>
            <span class="usage-dim">{{ formatTokens(row.tokens) }}</span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.usage-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 4px;
}

.usage-tile {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.usage-tile-label {
  font-size: 11px;
  color: var(--text-dim);
}

.usage-tile-value {
  font-size: 18px;
}

/* Bars scroll horizontally rather than compressing to slivers once a history
   runs past a couple of weeks.
   `flex: none` is load-bearing: .connect-panel is a flex column, so without it
   this box shrinks to its content, every bar's percentage height resolves
   against nothing, and the chart renders empty. */
.usage-chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  flex: none;
  overflow-x: auto;
  padding-bottom: 2px;
}

.usage-bar-slot {
  flex: 1 0 22px;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
}

.usage-bar {
  width: 100%;
  background: var(--accent);
  border-radius: 3px 3px 0 0;
  opacity: 0.75;
}

.usage-bar-slot:hover .usage-bar {
  opacity: 1;
}

.usage-bar-label {
  font-size: 9px;
  color: var(--text-dim);
  white-space: nowrap;
}

.usage-dim {
  color: var(--text-dim);
  font-size: 11px;
}

.agents-row-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

@media (max-width: 640px) {
  .usage-tiles {
    grid-template-columns: 1fr;
  }
}
</style>

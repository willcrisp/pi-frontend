<!--
  The menagerie: one creature per project, grown from that project's tokens and
  branched by the kind of work that fed it.

  Three questions, in the order people ask them:

    what is it now      — the sprite, its name, its stage and its type
    how did it get here — the lineage chain, one form per stage it passed
                          through, each labelled with the work that caused it
    what happens next   — tokens to the next evolution, and WHICH BRANCH it is
                          currently bending toward, so the next form is
                          something you can aim at rather than something that
                          merely happens to you

  Nothing here is stored: every creature is re-derived from the session list on
  open (see stores/creatures.js). The only write is the lineage log, which
  records when an evolution was first observed.
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import {
  activeCreature,
  formatTokens,
  menagerie,
  recordEvolutions,
} from "../../stores/creatures.js";
import { STAGES, branchLabel, genomeAtStage } from "../../lib/creature.js";
import { activeSessionDirectory, directoryLabel } from "../../stores/projects.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";
import CreatureSprite from "../chat/CreatureSprite.vue";

const emit = defineEmits(["close", "open-profile"]);

const selected = ref(activeSessionDirectory());
const creature = computed(() => activeCreature(selected.value));
const all = computed(() => menagerie());

// Announced on open rather than watched continuously: an evolution is a thing
// you come back and find, and a toast fired mid-turn would land while someone
// is reading an answer.
const justEvolved = ref([]);
onMounted(() => {
  justEvolved.value = recordEvolutions().map((c) => c.label || directoryLabel(c.directory));
});

// The chain: what it looked like at every stage it has been through, this one
// last. genomeAtStage replays the same rolls with fewer of them, so these are
// the actual past forms rather than a guess at them.
const chain = computed(() =>
  creature.value.lineage.map((link) => ({
    ...link,
    genome: genomeAtStage(creature.value, link.stage),
  }))
);

const nextStage = computed(() => creature.value.next);

// The branch preview, best-supported first. Only the ones with any support are
// worth showing — a nine-cell grid of zeroes says nothing.
const branchOptions = computed(() => {
  if (!nextStage.value) return [];
  const options = [...nextStage.value.options].sort(
    (a, b) => b.share - a.share || (b.leading ? 1 : 0) - (a.leading ? 1 : 0)
  );
  return options.filter((o) => o.share > 0 || o.leading).slice(0, 5);
});

function percent(v) {
  return `${Math.round((v || 0) * 100)}%`;
}

// Which part filled each slot. Worth showing: it is the difference between "your
// pet looks like that" and "your pet looks like that BECAUSE of these rolls",
// and it makes two creatures with the same lineage comparable at a glance.
const partsLabel = computed(() => {
  const p = creature.value.parts;
  if (!p) return "";
  return [p.body, p.eyes, p.limbs, p.crest, p.tail, p.pattern !== "none" ? p.pattern : null]
    .filter(Boolean)
    .join(" · ");
});

function ago(ts) {
  if (!ts) return "";
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const { onBackdrop } = useDialogEscape(() => emit("close"));
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Menagerie</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="justEvolved.length" class="mg-evolved">
        ✦ Evolved since you last looked: {{ justEvolved.join(", ") }}
      </p>

      <select v-model="selected" class="connect-filter" aria-label="Project">
        <option v-for="c in all" :key="c.directory" :value="c.directory">
          {{ c.label }} — {{ c.stageLabel }}
        </option>
      </select>

      <!-- Now -->
      <div class="mg-hero">
        <div class="mg-portrait">
          <CreatureSprite
            :genome="creature"
            :size="96"
            :progress="nextStage ? nextStage.progress : 0"
          />
        </div>
        <div class="mg-facts">
          <strong class="mg-name">{{ creature.name }}</strong>
          <span class="mg-sub">
            {{ creature.stageLabel }}
            <template v-if="creature.type"> · {{ branchLabel(creature.type) }}</template>
            <template v-if="creature.morph">
              · <span class="mg-morph">{{ creature.morph.label }}</span>
            </template>
          </span>
          <span class="mg-sub">{{ formatTokens(creature.tokens) }} tokens · {{ creature.sessionCount }}
            session{{ creature.sessionCount === 1 ? "" : "s" }}</span>
          <span v-if="creature.path" class="mg-path">{{ creature.path }}</span>
          <span v-if="partsLabel" class="mg-sub mg-parts">{{ partsLabel }}</span>
          <span v-if="creature.stage" class="mg-rarity">
            one shape in {{ creature.space.toLocaleString() }} at this depth
          </span>
          <div v-if="creature.traits.length" class="mg-traits">
            <span v-for="t in creature.traits" :key="t.id" class="mg-trait" :title="t.hint">
              {{ t.label }}
            </span>
          </div>
        </div>
      </div>

      <!-- Next -->
      <template v-if="nextStage">
        <div class="connect-head" style="margin-top: 14px">
          <span>Next evolution — {{ nextStage.label }}</span>
        </div>
        <div class="mg-progress" :title="`${formatTokens(nextStage.remaining)} tokens to go`">
          <div class="mg-progress-fill" :style="{ width: `${nextStage.progress * 100}%` }"></div>
        </div>
        <p class="connect-hint">
          {{ formatTokens(nextStage.remaining) }} more tokens in this project. On current work it
          branches <strong>{{ branchLabel(nextStage.leading) }}</strong> — the branch is decided by
          what you do between now and then, not by what you have done before.
        </p>
        <ul class="mg-branches">
          <li v-for="option in branchOptions" :key="option.id" :class="{ leading: option.leading }">
            <span class="mg-branch-label">{{ option.label }}</span>
            <span class="mg-branch-track">
              <span class="mg-branch-fill" :style="{ width: percent(option.share) }"></span>
            </span>
            <span class="mg-branch-value">{{ percent(option.share) }}</span>
          </li>
        </ul>
      </template>
      <p v-else class="connect-hint">
        Fully grown — {{ STAGES[STAGES.length - 1].label }} is the last stage.
      </p>

      <!-- How it got here -->
      <template v-if="chain.length">
        <div class="connect-head" style="margin-top: 14px"><span>Lineage</span></div>
        <ol class="mg-chain">
          <li class="mg-link">
            <CreatureSprite :genome="{ lineage: [], type: null, morph: null }" :size="32" />
            <span class="mg-link-stage">Egg</span>
          </li>
          <li v-for="link in chain" :key="link.stage" class="mg-link">
            <span class="mg-arrow">›</span>
            <CreatureSprite :genome="link.genome" :size="32" />
            <span class="mg-link-stage">{{ link.label }}</span>
            <span class="mg-link-branch">{{ branchLabel(link.branch) }}</span>
          </li>
        </ol>
        <p class="connect-hint">
          Each step is the work that fed it at that size. Fed differently, it would have grown into
          a different animal — that is the whole tree.
        </p>
      </template>

      <!-- Everything else -->
      <div class="connect-head" style="margin-top: 14px"><span>All projects</span></div>
      <ul class="agents-list">
        <li
          v-for="c in all"
          :key="c.directory"
          class="agents-row mg-row"
          :class="{ on: c.directory === selected }"
          @click="selected = c.directory"
        >
          <CreatureSprite :genome="c" :size="28" :progress="c.next ? c.next.progress : 0" />
          <div class="agents-row-main">
            <span class="agents-name">{{ c.name }}</span>
            <span class="agents-desc">
              {{ c.label }} · {{ c.stageLabel }}<template v-if="c.path"> · {{ c.path }}</template>
            </span>
          </div>
          <div class="agents-row-meta">
            <span>{{ formatTokens(c.tokens) }}</span>
            <span class="mg-dim">{{ ago(c.lastActive) }}</span>
          </div>
        </li>
      </ul>

      <p class="connect-hint">
        Tokens decide the stage; the kind of work decides the branch. What counts as which kind is
        the work profile —
        <button type="button" class="mg-link-btn" @click="$emit('open-profile')">
          open it
        </button>
        to see (and improve) how these sessions were read.
      </p>
    </div>
  </div>
</template>

<style scoped>
.mg-evolved {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--fg);
  margin-bottom: 8px;
}

.mg-hero {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin-top: 10px;
  flex: none;
}

.mg-portrait {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
  flex: none;
}

.mg-facts {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mg-name {
  font-size: 17px;
}

.mg-sub,
.mg-path,
.mg-rarity {
  font-size: 11px;
  color: var(--dim);
}

.mg-path {
  color: var(--fg);
}

.mg-parts {
  font-family: var(--mono);
  font-size: 10px;
}

.mg-morph {
  color: var(--accent);
}

.mg-traits {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.mg-trait {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 7px;
  font-size: 10px;
  line-height: 16px;
  color: var(--dim);
}

.mg-progress {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-raised);
  overflow: hidden;
  flex: none;
}

.mg-progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}

.mg-branches {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mg-branches li {
  display: grid;
  grid-template-columns: 66px 1fr 34px;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--dim);
}

.mg-branches li.leading {
  color: var(--fg);
}

.mg-branch-track {
  height: 5px;
  background: var(--bg-raised);
  border-radius: 3px;
  overflow: hidden;
}

.mg-branch-fill {
  display: block;
  height: 100%;
  background: var(--dim);
  border-radius: 3px;
}

.mg-branches li.leading .mg-branch-fill {
  background: var(--accent);
}

.mg-branch-value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mg-chain {
  list-style: none;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 4px;
  flex: none;
}

.mg-link {
  display: grid;
  grid-template-areas: "arrow sprite" "arrow stage" "arrow branch";
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 0 4px;
  text-align: center;
  flex: none;
}

.mg-link :deep(.creature-sprite) {
  grid-area: sprite;
  margin: 0 auto;
}

.mg-arrow {
  grid-area: arrow;
  color: var(--dim);
  padding: 0 2px;
}

.mg-link-stage {
  grid-area: stage;
  font-size: 9px;
  color: var(--dim);
}

.mg-link-branch {
  grid-area: branch;
  font-size: 9px;
  color: var(--fg);
}

.mg-row {
  cursor: pointer;
  align-items: center;
  gap: 10px;
}

.mg-row.on {
  background: var(--bg-raised);
}

.mg-dim {
  color: var(--dim);
  font-size: 11px;
}

.mg-link-btn {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}
</style>

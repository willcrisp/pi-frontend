// The genome: how a project's token history and work profile become a creature,
// and how that creature branches as it grows.
//
// Dependency-free and PURE. Everything here is a function of arguments —
// `deriveGenome()` given the same history returns the same creature, down to the
// pixel, forever and on every machine. That is not a nicety: a creature you can
// lose by clearing localStorage, or that redraws differently after a refresh, is
// not a creature anyone will care about. stores/creatures.js gathers the input
// and remembers *when* evolutions happened; nothing about what a creature IS is
// stored anywhere, because all of it is re-derivable from the session list.
//
// ── The shape of the thing ───────────────────────────────────────────────────
//
//   TOKENS decide the STAGE.   Six of them, on a roughly 5× curve (see STAGES).
//   WORK decides the BRANCH.   At each stage, whatever kind of work fed the
//                              creature *during that stage* is the branch it
//                              took — so the lineage is a record of what you
//                              were doing while it grew, in order.
//   LUCK decides the PARTS.    Two seeded rolls per stage — one for structure,
//                              one for surface — plus a rare morph.
//
// A creature is therefore a PATH, not a node: `frontend → testing → security` is
// a different animal from `security → testing → frontend`, and both are
// different from `frontend → testing → frontend`. Nine branch options (eight
// categories plus `mixed`) times the part slots each stage unlocks puts an Elder
// at roughly 27 million forms — and none of them is a stored asset: they are
// composited from 33 authored parts (lib/creatureparts.js) at render time.
//
// Overshooting the ask is not the point. The interesting property is the
// opposite one: TWO PEOPLE DOING THE SAME WORK IN THE SAME ORDER GET THE SAME
// LINEAGE. Rarity has to be earned or it is just noise.
import { CATEGORIES, CATEGORY_IDS, categoryLabel, dominant } from "./workcategories.js";
import {
  BODY_PLANS,
  CREST_KEYS,
  CROWN_KEYS,
  EYE_KEYS,
  LIMB_KEYS,
  PATTERN_KEYS,
  TAIL_KEYS,
  tierForStage,
} from "./creatureparts.js";

// --- Determinism -------------------------------------------------------------

// cyrb53. A string in, a well-mixed 53-bit number out — used to seed every roll
// so a creature's luck is a property of its identity rather than of when it was
// drawn.
export function hashSeed(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// mulberry32. Small, fast, and good enough for deciding whether something has
// horns.
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Stages ------------------------------------------------------------------
//
// Thresholds are cumulative tokens for the project, cache reads included —
// which is the honest measure of how much context has flowed through it, and
// the thing the user actually spends. Roughly 5× per stage, so the early ones
// arrive within a session or two (an evolution you never see is a mechanic that
// does not exist) and the last one is a genuine milestone rather than a
// fortnight's inevitability.
export const STAGES = [
  { stage: 0, at: 0, label: "Egg" },
  { stage: 1, at: 25_000, label: "Hatchling" },
  { stage: 2, at: 150_000, label: "Juvenile" },
  { stage: 3, at: 750_000, label: "Adept" },
  { stage: 4, at: 3_000_000, label: "Elder" },
  { stage: 5, at: 12_000_000, label: "Ancient" },
];

export const MAX_STAGE = STAGES.length - 1;

export function stageFor(tokens) {
  let found = STAGES[0];
  for (const s of STAGES) if (tokens >= s.at) found = s;
  return found;
}

// --- Branches ----------------------------------------------------------------

// The ninth branch. A stage fed by an even spread of work is not "frontend with
// noise" — it is its own thing, and the creature should say so rather than
// rounding to whatever won by two percent.
export const MIXED_BRANCH = "mixed";

// How dominant the leading category has to be to claim the branch. Below this,
// the stage went to `mixed`.
const BRANCH_THRESHOLD = 0.3;

export const BRANCH_IDS = [...CATEGORY_IDS, MIXED_BRANCH];

export function branchLabel(branch) {
  return branch === MIXED_BRANCH ? "Mixed" : categoryLabel(branch);
}

// Which branch a set of aggregated scores took.
export function branchOf(scores) {
  const top = dominant(scores);
  if (!top) return MIXED_BRANCH;
  return (scores[top] || 0) >= BRANCH_THRESHOLD ? top : MIXED_BRANCH;
}

// --- Mutations ---------------------------------------------------------------

// Body-plan variants per branch. Four is enough that two people on the same
// lineage usually differ, and few enough that a variant stays recognisable as a
// variant rather than a different species.
//
// ⚠️ Every choice table in creatureparts.js is exactly this long, because a slot
// is picked with `TABLE[roll]`. Changing this number, or the length of any of
// those tables, re-indexes every creature that already exists.
export const VARIANTS_PER_BRANCH = 4;

// Each evolution rolls TWICE — see the loop in deriveGenome: one roll for
// structure (body plan, limbs, crest, tail) and one for surface (eyes,
// pattern). A single roll per stage made a creature's eyes a function of its
// body: four bodies meant four faces, and the parts library collapsed to a
// quarter of the variety it was carrying.

// Rare cosmetic morphs, rolled once per evolution. The weights are the point:
// at ~1 in 11 per evolution, most creatures never get one, which is what makes
// a creature that did worth showing someone.
const MORPHS = [
  { id: "prismatic", label: "Prismatic", weight: 2, hint: "two hues, split down the body" },
  { id: "pale", label: "Pale", weight: 3, hint: "washed out, almost translucent" },
  { id: "shadow", label: "Shadow", weight: 3, hint: "dark, high contrast" },
  { id: "gilded", label: "Gilded", weight: 1, hint: "gold-edged — the rare one" },
];
// Per evolution, so the odds of ever seeing one compound with age: ~14% by
// stage 3, ~23% by stage 5. Tuned down from 9% after counting: at 9% a quarter
// of stage-3 creatures had a morph, and a mutation a quarter of everyone has is
// a feature, not a rarity.
const MORPH_CHANCE = 0.05;

function rollMorph(next) {
  if (next() >= MORPH_CHANCE) return null;
  const total = MORPHS.reduce((sum, m) => sum + m.weight, 0);
  let roll = next() * total;
  for (const morph of MORPHS) {
    roll -= morph.weight;
    if (roll <= 0) return morph;
  }
  return null;
}

// --- Names -------------------------------------------------------------------
//
// Built from the lineage rather than picked at random, so the name is readable
// as the creature's history once you know the scheme: first branch picks the
// stem, the newest branch picks the tail, and the stage picks the honorific.
const STEMS = {
  frontend: "Pix",
  backend: "Serv",
  data: "Quer",
  infra: "Cald",
  security: "Ward",
  testing: "Prov",
  docs: "Scri",
  tooling: "Forg",
  [MIXED_BRANCH]: "Var",
};

const TAILS = {
  frontend: "el",
  backend: "ax",
  data: "um",
  infra: "or",
  security: "yx",
  testing: "is",
  docs: "ath",
  tooling: "ux",
  [MIXED_BRANCH]: "oid",
};

const INFIX = ["o", "a", "i", "y"];
const CODA = ["", "a", "us", "ix"];

// Consonants and branches carry the history; the vowels carry the luck. Both
// vowel slots come from a hash of the whole variant vector rather than from one
// entry of it — summing the variants meant `v110` and `v101` produced the same
// name for two visibly different animals, which for a thing people collect is
// the one mistake worth avoiding.
//
// Sixteen name forms per lineage, which is fewer than the 64 body variants: the
// name is a label, not an identifier. The lineage and the body are what make a
// creature unique.
function nameFor(lineage, variants) {
  if (!lineage.length) return "Unhatched";
  const vector = variants.map((v) => `${v.variant}${v.decal}`).join(",");
  const roll = hashSeed(`name:${lineage.map((l) => l.branch).join(">")}:${vector}`);
  const stem = STEMS[lineage[0].branch] || "Var";
  const tail = TAILS[lineage[lineage.length - 1].branch] || "oid";
  const infix = lineage.length > 1 ? INFIX[roll % INFIX.length] : "";
  const mid = lineage.length > 2 ? (STEMS[lineage[1].branch] || "").toLowerCase() : "";
  const coda = lineage.length > 2 ? CODA[Math.floor(roll / INFIX.length) % CODA.length] : "";
  return `${stem}${infix}${mid}${tail}${coda}`;
}

// --- Traits ------------------------------------------------------------------
//
// Flavour derived from HOW the project's tokens were spent rather than how many.
// Deliberately read-only garnish: traits never gate an evolution, because a
// mechanic that quietly punishes someone for working the way they work is a
// mechanic that makes them resent the pet.
function traitsFor(input) {
  const traits = [];
  const { tokens, cacheRead, output, sessions, subagents, categoriesTouched } = input;

  if (tokens > 0 && cacheRead / tokens > 0.5) {
    traits.push({ id: "efficient", label: "Efficient", hint: "over half its context came from cache" });
  }
  if (tokens > 0 && output / tokens > 0.12) {
    traits.push({ id: "voluble", label: "Voluble", hint: "writes far more than it reads" });
  }
  if (sessions >= 3 && tokens / sessions > 250_000) {
    traits.push({ id: "deep", label: "Deep", hint: "long sessions, few of them" });
  } else if (sessions >= 8) {
    traits.push({ id: "brisk", label: "Brisk", hint: "many short sessions" });
  }
  if (subagents >= 3) {
    traits.push({ id: "hive", label: "Hive", hint: `${subagents} sub-agents dispatched` });
  }
  if (categoriesTouched >= 6) {
    traits.push({ id: "polymath", label: "Polymath", hint: "fed on six or more kinds of work" });
  } else if (categoriesTouched === 1) {
    traits.push({ id: "purebred", label: "Purebred", hint: "one kind of work, exclusively" });
  }
  return traits;
}

// --- Parts selection ---------------------------------------------------------
//
// Which part fills each slot. This is genome logic — deterministic indexing off
// the rolls — while what those parts LOOK like is creatureparts.js. The seam
// matters: replacing the placeholder art touches that file and not this one.
//
// Slots unlock with the stage, so an evolution always adds something visible:
//
//   stage 1  body plan + eyes          the animal exists
//   stage 2  limbs + pattern           it can move, and it has markings
//   stage 3  crest, and a bigger body
//   stage 4  tail, and a bigger body again
//   stage 5  the crest is replaced by a crown
//
// Each slot reads a DIFFERENT roll, so the features are independent: a creature
// whose body you recognise still surprises you at the horns.
function partsFor(lineage, rolls, stage) {
  if (!lineage.length) return null;
  const roll = (index, key) => (rolls[index] ? rolls[index][key] : 0);
  const crowned = stage >= MAX_STAGE;

  return {
    body: BODY_PLANS[roll(0, "variant") % BODY_PLANS.length],
    tier: tierForStage(stage),
    eyes: EYE_KEYS[roll(0, "decal") % EYE_KEYS.length],
    limbs: stage >= 2 ? LIMB_KEYS[roll(1, "variant") % LIMB_KEYS.length] : null,
    pattern: stage >= 2 ? PATTERN_KEYS[roll(1, "decal") % PATTERN_KEYS.length] : "none",
    crest: crowned
      ? CROWN_KEYS[roll(4, "variant") % CROWN_KEYS.length]
      : stage >= 3
        ? CREST_KEYS[roll(2, "variant") % CREST_KEYS.length]
        : null,
    crownSlot: crowned,
    tail: stage >= 4 ? TAIL_KEYS[roll(3, "variant") % TAIL_KEYS.length] : null,
  };
}

// How many of the six slots are actually filled at a stage — the exponent in the
// "one shape in N" figure, so that number counts forms you could actually meet
// rather than combinations of features that don't exist yet.
function filledSlots(stage) {
  if (stage <= 0) return 0;
  return 2 + (stage >= 2 ? 2 : 0) + (stage >= 3 ? 1 : 0) + (stage >= 4 ? 1 : 0);
}

// --- The genome ---------------------------------------------------------------

// Derive a creature.
//
//   input = {
//     key,          // stable identity: the project directory
//     originID,     // the id of the project's oldest session — the birth seed.
//                   // Deliberately NOT the directory: two people working in
//                   // ~/api would otherwise get identical luck.
//     windows,      // [{ tokens, scores }] one per crossed stage, oldest first,
//                   // where `scores` is the aggregate work profile of the
//                   // sessions that fed that stage
//     tokens,       // cumulative tokens for the project
//     pending,      // { tokens, scores } for the stage in progress
//     stats,        // { cacheRead, output, sessions, subagents, categoriesTouched }
//   }
//
// Returns the whole animal. `null` is never returned — a project with no tokens
// at all is an egg, which is a creature with a future rather than an absence.
export function deriveGenome(input) {
  const tokens = input.tokens || 0;
  const current = stageFor(tokens);
  const seedBase = input.originID || input.key || "unhatched";

  // One PRNG stream for the whole life, advanced in stage order. Because it is
  // seeded from identity alone and consumed in a fixed sequence, stage 2's roll
  // is the same value whether it was rolled today or a month ago — an evolution
  // can never retroactively change the luck of the stages below it.
  const next = rng(hashSeed(`${seedBase}::genome`));

  const lineage = [];
  const variants = [];
  let morph = null;

  for (let i = 0; i < current.stage; i++) {
    const window = input.windows[i] || { tokens: 0, scores: null };
    const branch = window.scores ? branchOf(window.scores) : MIXED_BRANCH;
    const roll = {
      variant: Math.floor(next() * VARIANTS_PER_BRANCH),
      decal: Math.floor(next() * VARIANTS_PER_BRANCH),
    };
    const rolled = rollMorph(next);
    // The newest morph wins, so a late mutation is visible rather than being
    // masked by one from three stages ago.
    if (rolled) morph = rolled;
    lineage.push({
      stage: i + 1,
      label: STAGES[i + 1].label,
      branch,
      variant: roll.variant,
      tokens: window.tokens || 0,
      at: STAGES[i + 1].at,
    });
    variants.push(roll);
  }

  const nextStage = STAGES[current.stage + 1] || null;
  const floor = current.at;
  const span = nextStage ? nextStage.at - floor : 0;
  const into = Math.max(0, tokens - floor);

  // What the stage in progress is trending toward — the branch it would take if
  // it evolved right now. This is the whole feedback loop: it tells you which
  // way the tree bends before you get there, so the next form is something you
  // can aim at rather than something that merely happens to you.
  const leading = input.pending?.scores ? branchOf(input.pending.scores) : MIXED_BRANCH;

  return {
    key: input.key,
    originID: input.originID || "",
    stage: current.stage,
    stageLabel: current.label,
    lineage,
    variants,
    morph,
    path: lineage.map((l) => l.branch).join(" › "),
    pathKey: variants.map((v, i) => `${lineage[i].branch}${v.variant}${v.decal}`).join(">"),
    type: lineage.length ? lineage[lineage.length - 1].branch : null,
    name: nameFor(lineage, variants),
    parts: partsFor(lineage, variants, current.stage),
    tokens,
    traits: traitsFor({
      tokens,
      cacheRead: input.stats?.cacheRead || 0,
      output: input.stats?.output || 0,
      sessions: input.stats?.sessions || 0,
      subagents: input.stats?.subagents || 0,
      categoriesTouched: input.stats?.categoriesTouched || 0,
    }),
    next: nextStage
      ? {
          stage: nextStage.stage,
          label: nextStage.label,
          at: nextStage.at,
          remaining: Math.max(0, nextStage.at - tokens),
          progress: span > 0 ? Math.min(1, into / span) : 0,
          leading,
          // Every branch it could still take, so the tree is visible rather than
          // being something you find out about afterwards.
          options: BRANCH_IDS.map((id) => ({
            id,
            label: branchLabel(id),
            leading: id === leading,
            share: input.pending?.scores ? input.pending.scores[id] || 0 : 0,
          })),
        }
      : null,
    // How many forms exist at this depth: every lineage that could reach it,
    // times every combination of the part slots that are unlocked. Shown, not
    // just computed — "one shape in 26 million" is the sentence that makes a
    // lineage feel worth keeping.
    space:
      Math.pow(BRANCH_IDS.length, current.stage) *
      Math.pow(VARIANTS_PER_BRANCH, filledSlots(current.stage)),
  };
}

// A genome for a lineage truncated to `stage`, so the dialog can show what the
// creature LOOKED like at each step of its history. Same rolls, fewer of them —
// which is exactly what a real past is.
export function genomeAtStage(genome, stage) {
  const lineage = genome.lineage.slice(0, stage);
  const variants = genome.variants.slice(0, stage);
  return {
    ...genome,
    stage,
    stageLabel: STAGES[stage]?.label || genome.stageLabel,
    lineage,
    variants,
    pathKey: variants.map((v, i) => `${lineage[i].branch}${v.variant}${v.decal}`).join(">"),
    type: lineage.length ? lineage[lineage.length - 1].branch : null,
    name: nameFor(lineage, variants),
    // Re-selected, not inherited: at a smaller stage it had fewer slots filled
    // and a smaller body, which is the point of drawing the past at all.
    parts: partsFor(lineage, variants, stage),
  };
}

// Every category, for the "what could it become" grid. Exported so the dialog
// doesn't reach into workcategories.js for a list this module already orders.
export const BRANCH_CHOICES = [
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
  { id: MIXED_BRANCH, label: "Mixed" },
];

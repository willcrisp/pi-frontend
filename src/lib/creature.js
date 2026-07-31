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
//   LUCK decides the VARIANT.  A seeded roll per stage, plus a rare morph.
//
// A creature is therefore a PATH, not a node: `frontend → testing → security` is
// a different animal from `security → testing → frontend`, and both are
// different from `frontend → testing → frontend`. With nine branch options
// (eight categories plus `mixed`) and four variants per link, stage 3 alone has
// 9³ × 4³ = 46,656 forms before the morph roll, and the tree keeps branching to
// stage 5. Hundreds was the ask; the arithmetic overshoots it on purpose,
// because the interesting property is that TWO PEOPLE DOING THE SAME WORK GET
// THE SAME LINEAGE — the rarity has to mean something or it is just noise.
import { CATEGORIES, CATEGORY_IDS, categoryLabel, dominant } from "./workcategories.js";

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

// Hue per branch, for the sprite only. This is decoration, not data encoding —
// every creature is captioned with its type in words, so nothing here is the
// sole carrier of meaning.
const BRANCH_HUE = {
  frontend: 213,
  backend: 145,
  data: 41,
  infra: 190,
  security: 353,
  testing: 275,
  docs: 225,
  tooling: 25,
  [MIXED_BRANCH]: 300,
};

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
export const VARIANTS_PER_BRANCH = 4;

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
  const roll = hashSeed(`name:${lineage.map((l) => l.branch).join(">")}:${variants.join(",")}`);
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
    const variant = Math.floor(next() * VARIANTS_PER_BRANCH);
    const rolled = rollMorph(next);
    // The newest morph wins, so a late mutation is visible rather than being
    // masked by one from three stages ago.
    if (rolled) morph = rolled;
    lineage.push({
      stage: i + 1,
      label: STAGES[i + 1].label,
      branch,
      variant,
      tokens: window.tokens || 0,
      at: STAGES[i + 1].at,
    });
    variants.push(variant);
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
    pathKey: lineage.map((l) => `${l.branch}${l.variant}`).join(">"),
    type: lineage.length ? lineage[lineage.length - 1].branch : null,
    name: nameFor(lineage, variants),
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
    // How many forms exist at this depth. Shown, not just computed: "one of
    // 46,656" is the sentence that makes a lineage feel worth keeping.
    space: Math.pow(BRANCH_IDS.length * VARIANTS_PER_BRANCH, current.stage),
  };
}

// --- The sprite ---------------------------------------------------------------
//
// A deterministic 16×16 pixel creature, mirrored down the middle. The art is
// crude on purpose — the ask was the evolution system, not the pixels — but it
// has to satisfy two things to be worth drawing at all: the same genome must
// always produce the same body, and two different lineages must be visibly
// different animals rather than the same blob in another colour.
export const SPRITE_SIZE = 16;

// Palette slots the grid indexes into. Kept as indices rather than colours so a
// caller can restyle without regenerating.
export const PIXEL = { EMPTY: 0, BODY: 1, ACCENT: 2, EYE: 3, SHELL: 4 };

export function spriteFor(genome) {
  const grid = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE);
  const set = (x, y, value) => {
    if (x < 0 || y < 0 || x >= SPRITE_SIZE || y >= SPRITE_SIZE) return;
    grid[y * SPRITE_SIZE + x] = value;
    // Mirror. A creature symmetrical about its spine reads as an animal; the
    // same generator without this reads as static.
    grid[y * SPRITE_SIZE + (SPRITE_SIZE - 1 - x)] = value;
  };

  if (!genome.lineage.length) return { grid, egg: true, palette: paletteFor(genome) };

  const next = rng(hashSeed(`${genome.originID}::${genome.pathKey}::sprite`));
  const stage = genome.stage;

  // The body grows with the stage — the single most legible signal that
  // something evolved, before any of the detail is even looked at.
  const height = Math.min(4 + stage * 2, 13);
  const width = Math.min(2 + stage, 7);
  const top = Math.max(1, Math.floor((SPRITE_SIZE - height) / 2));
  const midY = top + height / 2;

  for (let y = top; y < top + height; y++) {
    for (let x = SPRITE_SIZE / 2 - width; x < SPRITE_SIZE / 2; x++) {
      const nx = (SPRITE_SIZE / 2 - x) / width;
      const ny = Math.abs(y - midY) / (height / 2);
      const r = Math.sqrt(nx * nx * 0.85 + ny * ny);
      // A hard ellipse is a pill; the noise term is what gives each variant its
      // own silhouette.
      if (r < 0.72 + next() * 0.45) set(x, y, PIXEL.BODY);
    }
  }

  // Appendages: limbs from stage 2, horns/crests from stage 3, a tail from 4.
  // Each is rolled from the same stream, so a creature's fifth-stage crest is
  // fixed the moment its lineage is.
  const limbs = Math.max(0, stage - 1);
  for (let i = 0; i < limbs; i++) {
    const y = top + 1 + Math.floor(next() * (height - 2));
    const reach = 1 + Math.floor(next() * 2);
    for (let d = 1; d <= reach; d++) set(SPRITE_SIZE / 2 - width - d, y, PIXEL.ACCENT);
  }
  if (stage >= 3) {
    const spikes = 1 + Math.floor(next() * 2);
    for (let i = 0; i < spikes; i++) {
      const x = SPRITE_SIZE / 2 - 1 - Math.floor(next() * width);
      set(x, top - 1, PIXEL.ACCENT);
    }
  }
  if (stage >= 4) {
    const y = top + height;
    set(SPRITE_SIZE / 2 - 1, y, PIXEL.ACCENT);
    set(SPRITE_SIZE / 2 - 2, y, PIXEL.ACCENT);
  }

  // Eyes last, so nothing overwrites them. Placed in the upper third of the
  // body and forced on even where the body pixel is missing — a creature
  // without eyes stops being a creature.
  const eyeY = Math.round(top + height * 0.32);
  const eyeX = SPRITE_SIZE / 2 - Math.max(1, Math.min(width - 1, 2));
  set(eyeX, eyeY, PIXEL.EYE);

  return { grid, egg: false, palette: paletteFor(genome) };
}

// The egg has its own body, and cracks as it approaches hatching — the one bit
// of state a stage-0 creature has to show, and the reason not to draw it as an
// empty box.
export function eggSprite(progress) {
  const grid = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE);
  const set = (x, y, v) => {
    grid[y * SPRITE_SIZE + x] = v;
    grid[y * SPRITE_SIZE + (SPRITE_SIZE - 1 - x)] = v;
  };
  const top = 3;
  const height = 10;
  const width = 5;
  for (let y = top; y < top + height; y++) {
    for (let x = SPRITE_SIZE / 2 - width; x < SPRITE_SIZE / 2; x++) {
      const nx = (SPRITE_SIZE / 2 - x) / width;
      // Egg-shaped: narrower at the top than the bottom.
      const taper = 0.72 + 0.28 * ((y - top) / height);
      const ny = Math.abs(y - (top + height / 2)) / (height / 2);
      if (Math.sqrt(nx * nx * 0.8 + ny * ny) < taper) set(x, y, PIXEL.SHELL);
    }
  }
  if (progress > 0.5) {
    set(SPRITE_SIZE / 2 - 1, top + 4, PIXEL.EMPTY);
    set(SPRITE_SIZE / 2 - 2, top + 5, PIXEL.EMPTY);
  }
  if (progress > 0.8) {
    set(SPRITE_SIZE / 2 - 3, top + 6, PIXEL.EMPTY);
    set(SPRITE_SIZE / 2 - 1, top + 7, PIXEL.EMPTY);
  }
  return { grid, egg: true, palette: paletteFor({ type: null, morph: null }) };
}

function paletteFor(genome) {
  const hue = BRANCH_HUE[genome.type] ?? 210;
  const morph = genome.morph?.id;

  if (morph === "pale") {
    return ["transparent", `hsl(${hue} 22% 78%)`, `hsl(${hue} 30% 88%)`, "#10141a", "#6b7480"];
  }
  if (morph === "shadow") {
    return ["transparent", `hsl(${hue} 32% 26%)`, `hsl(${hue} 60% 46%)`, "#e8ecf2", "#6b7480"];
  }
  if (morph === "gilded") {
    return ["transparent", `hsl(${hue} 45% 52%)`, "#e8c26a", "#10141a", "#6b7480"];
  }
  if (morph === "prismatic") {
    return ["transparent", `hsl(${hue} 62% 58%)`, `hsl(${(hue + 140) % 360} 62% 58%)`, "#10141a", "#6b7480"];
  }
  return ["transparent", `hsl(${hue} 48% 55%)`, `hsl(${hue} 62% 70%)`, "#10141a", "#6b7480"];
}

// A genome for a lineage truncated to `stage`, so the dialog can show what the
// creature LOOKED like at each step of its history. Same rolls, fewer of them —
// which is exactly what a real past is.
export function genomeAtStage(genome, stage) {
  const lineage = genome.lineage.slice(0, stage);
  return {
    ...genome,
    stage,
    stageLabel: STAGES[stage]?.label || genome.stageLabel,
    lineage,
    variants: genome.variants.slice(0, stage),
    pathKey: lineage.map((l) => `${l.branch}${l.variant}`).join(">"),
    type: lineage.length ? lineage[lineage.length - 1].branch : null,
    name: nameFor(lineage, genome.variants),
  };
}

// Every category, for the "what could it become" grid. Exported so the dialog
// doesn't reach into workcategories.js for a list this module already orders.
export const BRANCH_CHOICES = [
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
  { id: MIXED_BRANCH, label: "Mixed" },
];

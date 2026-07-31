// The parts library: the actual art, and the rules for assembling it.
//
// A creature is composited from one part per slot. lib/creature.js decides WHICH
// part fills each slot (deterministically, from the genome); this file says what
// those parts are and where they go. Replacing the placeholder art with drawn
// art means editing the tables below and nothing else.
//
// ── Two kinds of part ────────────────────────────────────────────────────────
//
//   BODIES are volumes — a stack of 8×8 layers of ASCII, read bottom-up, which
//   is the format a pixel artist can edit in a text editor without tooling.
//
//   APPENDAGES are clusters — short lists of [x, y, z] offsets from a named
//   anchor on the body's bounding box. Offsets rather than fixed grids because
//   bodies differ in size across stages: a horn authored at an absolute
//   coordinate would float off a small body and sink into a large one, and every
//   body tier would need its own copy of every horn.
//
//   EYES are neither: they are projected onto whatever the body's front surface
//   turns out to be, so the art is only "how many eyes, how far apart".
//
// ── Every choice table is exactly VARIANTS_PER_BRANCH long ───────────────────
// A slot is chosen with `TABLE[variant]`, so a table with a different length
// would re-index every existing creature — appending a fifth horn silently
// reshuffles everyone's pets. To grow the library, replace an entry (art
// change, same creature) or add a slot (new roll, existing creatures unchanged).
// Anything else needs RENDER_VERSION bumped and the redraw accepted.
import { voxelKey } from "./voxel.js";

// The authoring footprint. Bodies live inside it; appendages may reach outside.
//
// ODD on purpose. On an even grid there is no centre column, so `round(centre)`
// lands off-axis and a symmetric body gets asymmetric eyes — one eye on the
// front face, its partner one cube around the side. Everything here is authored
// symmetrically about x = 4 and z = 4.
const W = 9;
const CENTRE = 4;

export const RENDER_VERSION = 1;

// Palette slots. The numbers are what land in the voxel map.
export const SLOT = { BODY: 1, ACCENT: 2, EYE: 3, SHELL: 4 };

// --- Layer vocabulary --------------------------------------------------------
//
// Named 8×8 cross-sections, shared by every body. Rows are z (back to front),
// characters are x. A body is a recipe over these, which is what keeps twelve
// bodies to twelve short lines instead of twelve screens of ASCII.
const LAYERS = {
  core: [
    ".........",
    ".........",
    ".........",
    "...###...",
    "...###...",
    "...###...",
    ".........",
    ".........",
    ".........",
  ],
  small: [
    ".........",
    ".........",
    "...###...",
    "..#####..",
    "..#####..",
    "..#####..",
    "...###...",
    ".........",
    ".........",
  ],
  mid: [
    ".........",
    "...###...",
    "..#####..",
    ".#######.",
    ".#######.",
    ".#######.",
    "..#####..",
    "...###...",
    ".........",
  ],
  wide: [
    "...###...",
    "..#####..",
    ".#######.",
    "#########",
    "#########",
    "#########",
    ".#######.",
    "..#####..",
    "...###...",
  ],
  cross: [
    ".........",
    "...###...",
    "...###...",
    ".#######.",
    ".#######.",
    ".#######.",
    "...###...",
    "...###...",
    ".........",
  ],
};

// --- Bodies ------------------------------------------------------------------
//
// Four plans × three size tiers. The plan is fixed at the first evolution and
// never changes; the tier follows the stage, which is what makes an evolution
// visible at a glance before any detail is read.
// Roughly as tall as they are wide, at every tier. The first cut of these was
// two or three layers over a seven-wide footprint, and in an isometric
// projection that is not a creature, it is a paving slab: the camera compresses
// height and exaggerates the footprint, so a body that reads as chunky in plan
// reads as flat on screen. When adding a plan, count its layers against its
// widest layer.
const BODIES = {
  round: {
    xs: ["core", "small", "small", "core"],
    s: ["core", "small", "small", "small", "core"],
    m: ["small", "mid", "mid", "mid", "small", "core"],
    l: ["small", "mid", "wide", "wide", "mid", "mid", "small", "core"],
  },
  tall: {
    xs: ["core", "core", "core", "core"],
    s: ["core", "core", "small", "core", "core"],
    m: ["core", "small", "small", "small", "small", "core"],
    l: ["core", "small", "small", "mid", "small", "small", "small", "core"],
  },
  chunky: {
    xs: ["small", "small", "core"],
    s: ["small", "mid", "small", "core"],
    m: ["mid", "wide", "mid", "small", "core"],
    l: ["wide", "wide", "mid", "mid", "mid", "small", "core"],
  },
  spiny: {
    xs: ["core", "cross", "core"],
    s: ["core", "cross", "cross", "core"],
    m: ["small", "cross", "cross", "cross", "core"],
    l: ["mid", "cross", "cross", "cross", "cross", "mid", "core"],
  },
};

// Ordered and fixed: index 0..3 is what a variant roll selects. Append-only, and
// see the header before appending.
export const BODY_PLANS = ["round", "tall", "chunky", "spiny"];

// Four tiers over five stages. Every evolution up to Elder changes the tier, so
// growth is visible before any detail is looked at — with three tiers, stages 1
// and 2 shared a body and the second evolution looked like nothing happened.
export function tierForStage(stage) {
  if (stage >= 4) return "l";
  if (stage >= 3) return "m";
  if (stage >= 2) return "s";
  return "xs";
}

// --- Appendages --------------------------------------------------------------
//
// [x, y, z] offsets from the anchor named on each table.

// Anchor: top-centre of the body. Grows upward.
export const CRESTS = {
  horns: [[-2, 1, 0], [-2, 2, 0], [2, 1, 0], [2, 2, 0]],
  fin: [[0, 1, -1], [0, 1, 0], [0, 1, 1], [0, 2, 0]],
  antennae: [[-1, 1, 0], [-1, 2, 0], [-1, 3, 0], [1, 1, 0], [1, 2, 0], [1, 3, 0]],
  ridge: [[0, 1, -2], [0, 1, -1], [0, 1, 0], [0, 1, 1], [0, 1, 2]],
};
export const CREST_KEYS = ["horns", "fin", "antennae", "ridge"];

// Reached at stage 5 only, replacing the crest — a visible payoff for the last
// evolution, which is otherwise the one that changes least.
export const CROWNS = {
  halo: [[-2, 2, 0], [2, 2, 0], [0, 2, -2], [0, 2, 2], [-1, 2, -1], [1, 2, 1], [-1, 2, 1], [1, 2, -1]],
  spikes: [[-2, 1, 0], [-2, 2, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0], [2, 1, 0], [2, 2, 0]],
  plates: [[-2, 1, -1], [-2, 1, 1], [2, 1, -1], [2, 1, 1], [0, 2, 0]],
  orb: [[0, 2, 0], [0, 3, 0], [-1, 3, 0], [1, 3, 0], [0, 3, -1], [0, 3, 1]],
};
export const CROWN_KEYS = ["halo", "spikes", "plates", "orb"];

// Anchor: the body's left face, low. Mirrored to the right automatically, so
// these are authored once for one side.
export const LIMBS = {
  stubs: [[-1, 0, 0]],
  legs: [[-1, 0, 0], [-1, -1, 0]],
  tendrils: [[-1, 0, 0], [-2, 0, 0], [-2, 1, 0]],
  arms: [[-1, 1, 0], [-2, 1, 0], [-2, 0, 0]],
};
export const LIMB_KEYS = ["stubs", "legs", "tendrils", "arms"];

// Anchor: the body's back face, low. Grows away from the camera.
export const TAILS = {
  stub: [[0, 0, -1]],
  long: [[0, 0, -1], [0, 0, -2], [0, 1, -3]],
  forked: [[0, 0, -1], [0, 0, -2], [-1, 1, -3], [1, 1, -3]],
  fan: [[0, 0, -1], [-1, 0, -2], [1, 0, -2], [0, 1, -2]],
};
export const TAIL_KEYS = ["stub", "long", "forked", "fan"];

// --- Eyes and patterns -------------------------------------------------------
//
// Both recolour existing voxels rather than adding any, so neither can ever
// leave a feature floating in the air off the side of a body it doesn't fit.

// [dx, dy] from the centre of the eye row. Projected onto the front surface.
export const EYES = {
  pair: [[-1, 0], [1, 0]],
  wide: [[-2, 0], [2, 0]],
  stack: [[-1, 0], [1, 0], [-1, -1], [1, -1]],
  single: [[0, 0]],
};
export const EYE_KEYS = ["pair", "wide", "stack", "single"];

// Predicates over a voxel and the body's bounds. Four one-liners rather than
// four more tables: a pattern is a rule about a surface, not a shape.
export const PATTERNS = {
  none: () => false,
  stripe: (x) => x === CENTRE,
  spots: (x, y, z) => (x * 7 + y * 13 + z * 5) % 5 === 0,
  belly: (x, y, z, b) => y <= b.minY + 1,
};
export const PATTERN_KEYS = ["none", "stripe", "spots", "belly"];

// --- Palettes ----------------------------------------------------------------
//
// [h, s, l] per slot; lib/voxel.js derives the three face shades from each, so
// one authored colour per slot lights a whole solid.
const BRANCH_HSL = {
  frontend: [213, 55, 50],
  backend: [145, 42, 44],
  data: [41, 62, 50],
  infra: [188, 48, 46],
  security: [353, 52, 52],
  testing: [275, 42, 54],
  docs: [222, 22, 56],
  tooling: [25, 58, 48],
  mixed: [305, 32, 50],
};

export function paletteFor(genome) {
  const base = BRANCH_HSL[genome?.type] || [210, 20, 48];
  let [h, s, l] = base;
  let accent = [h, Math.min(90, s + 18), Math.min(80, l + 14)];
  let eye = [h, 18, 88];

  switch (genome?.morph?.id) {
    case "pale":
      s = Math.round(s * 0.3);
      l = Math.min(82, l + 24);
      accent = [h, s + 10, Math.min(90, l + 8)];
      // A pale body would swallow a pale eye, so this is the one morph that
      // inverts it.
      eye = [h, 45, 26];
      break;
    case "shadow":
      s = Math.round(s * 0.7);
      l = Math.round(l * 0.5);
      accent = [h, s + 20, l + 26];
      eye = [h, 70, 78];
      break;
    case "gilded":
      accent = [45, 72, 58];
      break;
    case "prismatic":
      accent = [(h + 140) % 360, Math.min(90, s + 20), Math.min(80, l + 12)];
      break;
    default:
      break;
  }

  const palette = [];
  palette[SLOT.BODY] = [h, s, l];
  palette[SLOT.ACCENT] = accent;
  palette[SLOT.EYE] = eye;
  palette[SLOT.SHELL] = [38, 12, 60];
  return palette;
}

// --- Composition -------------------------------------------------------------

function stampLayers(voxels, recipe, slot) {
  recipe.forEach((layerName, y) => {
    const layer = LAYERS[layerName];
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        if (layer[z][x] !== ".") voxels.set(voxelKey(x, y, z), slot);
      }
    }
  });
}

function boundsOf(voxels) {
  const b = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const key of voxels.keys()) {
    const [x, y, z] = key.split(",").map(Number);
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
    b.minZ = Math.min(b.minZ, z);
    b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
}

function stampCluster(voxels, cluster, [ax, ay, az], slot) {
  for (const [dx, dy, dz] of cluster) {
    voxels.set(voxelKey(ax + dx, ay + dy, az + dz), slot);
  }
}

// Eyes sit ON the front surface, one cube proud of it: for each authored x
// offset, walk z from the front backwards until a body voxel is found, then
// place the eye directly in front of that one. A body with a notch, an overhang,
// or simply a different silhouette therefore still gets eyes on its face, and
// never floating in space — the found voxel is always their neighbour.
//
// Proud rather than flush, and pale rather than dark, because a recoloured
// surface cube shows all three of its faces at once: as a dark slot it read as a
// HOLE punched through the creature, not as an eye. Standing one cube out gives
// it its own silhouette, and the pale slot separates it from the body it sits on.
function applyEyes(voxels, bounds, offsets) {
  const row = bounds.maxY - Math.max(1, Math.round((bounds.maxY - bounds.minY) * 0.3));
  for (const [dx, dy] of offsets) {
    const x = CENTRE + dx;
    const y = row + dy;
    for (let z = bounds.maxZ; z >= bounds.minZ; z--) {
      if (voxels.has(voxelKey(x, y, z))) {
        voxels.set(voxelKey(x, y, z + 1), SLOT.EYE);
        break;
      }
    }
  }
}

function applyPattern(voxels, bounds, predicate) {
  for (const [key, slot] of [...voxels]) {
    if (slot !== SLOT.BODY) continue;
    const [x, y, z] = key.split(",").map(Number);
    if (predicate(x, y, z, bounds)) voxels.set(key, SLOT.ACCENT);
  }
}

// The egg: its own small body, cracked open as it nears hatching. Stage 0 is the
// state most creatures are in when someone first opens the menagerie, so it is
// the one that most needs to look like something rather than like an absence.
function eggVolume(progress) {
  const voxels = new Map();
  // Tapered at both ends and taller than it is wide — the silhouette is the only
  // thing telling someone this is an egg rather than a rock.
  stampLayers(voxels, ["core", "small", "small", "small", "core"], SLOT.SHELL);
  // Cracks are voxels taken OUT of the front face, so they read as breaks in the
  // shell rather than as lines painted on it.
  if (progress > 0.5) {
    voxels.delete(voxelKey(4, 2, 6));
  }
  if (progress > 0.8) {
    voxels.delete(voxelKey(3, 3, 6));
    voxels.delete(voxelKey(5, 2, 6));
    voxels.delete(voxelKey(4, 1, 6));
  }
  return voxels;
}

// Build the whole animal. Order matters: body, then pattern (which recolours the
// body), then the appendages, then the eyes last so nothing can bury them.
export function composeCreature(genome, { progress = 0 } = {}) {
  if (!genome?.parts || !genome.lineage?.length) {
    return { voxels: eggVolume(progress), palette: paletteFor(null) };
  }

  const parts = genome.parts;
  const voxels = new Map();
  stampLayers(voxels, BODIES[parts.body][parts.tier], SLOT.BODY);
  const bounds = boundsOf(voxels);

  applyPattern(voxels, bounds, PATTERNS[parts.pattern] || PATTERNS.none);

  const cz = CENTRE;

  if (parts.limbs) {
    // Authored for the left side only, then reflected onto the right, so a limb
    // can never come out asymmetric — which on a creature reads as a bug rather
    // than as variety.
    const limb = LIMBS[parts.limbs];
    stampCluster(voxels, limb, [bounds.minX, bounds.minY + 1, cz], SLOT.ACCENT);
    stampCluster(
      voxels,
      limb.map(([x, y, z]) => [-x, y, z]),
      [bounds.maxX, bounds.minY + 1, cz],
      SLOT.ACCENT
    );
  }
  if (parts.crest) {
    const table = parts.crownSlot ? CROWNS : CRESTS;
    stampCluster(voxels, table[parts.crest], [CENTRE, bounds.maxY, cz], SLOT.ACCENT);
  }
  if (parts.tail) {
    stampCluster(voxels, TAILS[parts.tail], [CENTRE, bounds.minY + 1, bounds.minZ], SLOT.ACCENT);
  }

  applyEyes(voxels, bounds, EYES[parts.eyes] || EYES.pair);

  return { voxels, palette: paletteFor(genome) };
}

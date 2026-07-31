# Creatures

A pixel creature per project, grown from that project's tokens and branched by
the kind of work that fed it. The header chip is this project's; the menagerie
is all of them.

This is the design record. The code is:

| Piece | File |
|---|---|
| the genome: stages, branches, rolls, names, which part fills each slot | `src/lib/creature.js` (pure) |
| **the art**: bodies, appendages, eyes, patterns, palettes, composition | `src/lib/creatureparts.js` |
| isometric projection, face culling, shading | `src/lib/voxel.js` (generic) |
| assembling a project's history into the genome's input | `src/stores/creatures.js` |
| the renderer | `src/components/chat/CreatureSprite.vue` |
| the menagerie | `src/components/dialogs/MenagerieDialog.vue` |

The pipeline runs strictly one way, and the seams are where they are so that
**replacing the placeholder art touches one file**:

```
genome  →  part names   →  voxel volume    →  culled faces  →  SVG
creature.js  creatureparts.js   voxel.js       CreatureSprite.vue
```

It sits directly on top of the work profile (`docs/work-profile.md`): the profile
answers "what kind of work was this session", and a creature is that answer
accumulated in the order it happened.

## The three axes

```
TOKENS decide the STAGE     0 · 25k · 150k · 750k · 3m · 12m   (cumulative, per project)
WORK   decides the BRANCH   whatever fed the creature while it was at that stage
LUCK   decides the VARIANT  a seeded roll per evolution, plus a rare morph
```

**A creature is a path, not a node.** `frontend → testing → security` is a
different animal from `security → testing → frontend`, and both differ from
`frontend → testing → frontend`. Nine branch options (the eight categories plus
`mixed`) and four body variants per link put stage 3 alone at 9³ × 4³ = 46,656
forms before the morph roll, and the tree keeps branching to stage 5.

The arithmetic overshoots "hundreds" on purpose, because the interesting property
is the opposite of raw variety: **two people who did the same work in the same
order get the same lineage.** Rarity has to mean something or it is just noise.

### Stages

Roughly 5× per stage. The early ones land within a session or two — an evolution
nobody ever sees is a mechanic that does not exist — and the last is a genuine
milestone rather than a fortnight's inevitability. Tokens are cumulative and
include cache reads, which is the honest measure of how much context has flowed
through a project.

### Branches

The branch for a stage is the dominant category of the work that fed the creature
*while it was at that stage* — not its lifetime profile, which would make every
mature creature the same shape. A stage whose leading category is under 30% takes
the ninth branch, `mixed`: a stage fed by an even spread is its own thing, not
"frontend with noise" rounded off by two percent.

**A session that spans a threshold is credited to both windows, in proportion to
the tokens either side.** Its work — the category scores — counts whole in each;
only the weight splits, because half a session is still the same kind of work.
This is not a detail: crediting a spanning session whole to the stage it ended in
made the "what is it eating now" preview lag by an entire stage, because the 500k
session that *triggered* an evolution outweighed everything done since. A
creature that had spent a fortnight on docs still claimed it was branching
testing. `test/creatures.spec.js` pins this.

### Luck

One PRNG stream per creature, seeded from the id of the project's **oldest
session** (not the directory — two people working in `~/api` would otherwise get
identical luck) and consumed in stage order. Because the stream is seeded from
identity and drawn in a fixed sequence, stage 2's roll is the same value whether
it was rolled today or a month ago: **an evolution can never retroactively change
the luck of the stages below it.**

Morphs (`prismatic`, `pale`, `shadow`, `gilded`) roll at 5% per evolution — ~14%
by stage 3, ~23% by stage 5. Tuned down from 9% after counting: at 9% a quarter
of stage-3 creatures had one, and a mutation a quarter of everyone has is a
feature rather than a rarity.

## Nothing is stored

A creature is **derived**, every time, from the session list the sidebar already
fetched. There is no saved creature to migrate, corrupt, or lose; it survives
clearing localStorage, switching machines, and this file being rewritten, because
the animal was never the state — your history is. It also costs **zero
requests**: tokens come off `SessionV2.Info`, which `GET /session` already
returned.

That trade is only sound if the derivation is exactly reproducible, so
`lib/creature.js` is pure and `creatures.spec.js` asserts the same history draws
the same pixels across a reload.

The one genuinely underivable fact is **when** an evolution happened — the
session list records when a session was last touched, not when a running total
crossed a line — so that alone is logged, and only to say "evolved since you last
looked".

### The consequence worth knowing

Improving a session's classification (scanning transcripts, or a model pass) can
change a past branch, because the branch is re-derived from it. A creature's
history can therefore be *corrected*. This is deliberate: the alternative is
freezing a lineage against the weakest evidence the profile ever had — a
title-only guess — forever. Better profile, truer animal.

## The art: a parts library, not a sprite sheet

**You never generate 46,656 creatures.** That is the size of the reachable space,
not an asset count — and it is the *small* number: at stage 5 it is tens of
millions, so anything costing one artifact per creature loses that race however
cheap the artifact is. Composition costs one artifact per **part**, and the parts
don't multiply when the tree does.

So: **33 authored parts**, composited per genome.

| Slot | Parts | Unlocks at | Chosen by |
|---|---|---|---|
| body plan × 4 size tiers | 16 | stage 1 | structure roll, stage 1 |
| eyes | 4 | stage 1 | surface roll, stage 1 |
| limbs | 4 | stage 2 | structure roll, stage 2 |
| pattern | 4 | stage 2 | surface roll, stage 2 |
| crest | 4 | stage 3 | structure roll, stage 3 |
| tail | 4 | stage 4 | structure roll, stage 4 |
| crown (replaces the crest) | 4 | stage 5 | structure roll, stage 5 |

Each evolution rolls **twice** — once for structure, once for surface. With a
single roll per stage a creature's eyes were a function of its body: four bodies
meant four faces, and the library lost three quarters of the variety it was
carrying.

Bodies are stacks of 9×9 ASCII layers, read bottom-up, editable in any text
editor without tooling. Appendages are short `[x, y, z]` offset lists anchored to
the body's bounding box, so one horn fits every body tier instead of needing a
copy per size. Eyes and patterns only *recolour* voxels that already exist, so
neither can leave a feature floating in space.

### The trap: choice tables are exactly `VARIANTS_PER_BRANCH` long

A slot is filled with `TABLE[roll]`. Appending a fifth horn to a four-entry table
re-indexes **every creature that already exists** — everyone's pet quietly
changes. To grow the library: replace an entry (an art change, same creature), or
add a whole slot reading a roll nothing else uses (existing creatures unchanged).
Anything else means bumping `RENDER_VERSION` and accepting the redraw.

### Rendering

Isometric voxels: `sx = (x - z)·2`, `sy = (x + z) - 2y`, so exactly three faces of
any cube can face the camera and the rest are culled before they are ever built —
a solid creature comes out around 150 polygons. One authored colour per palette
slot becomes three shades (top lit, +z mid, +x dark), which is what reads as
volume. Every vertex lands on a whole unit, so with `shape-rendering: crispEdges`
the cube edges stay hard at 16px in the header and 96px in the menagerie, from the
same geometry.

Two rules the placeholder art had to learn the hard way, both worth keeping:

- **Count layers against the widest layer.** The first bodies were three layers
  over a seven-wide footprint. Isometric compresses height and exaggerates
  footprint, so they rendered as paving slabs.
- **Eyes stand one cube proud, and pale.** Recolouring a surface cube dark shows
  all three of its faces at once and reads as a *hole punched through the
  creature*. Standing out gives an eye its own silhouette.

The art is crude on purpose; the pipeline is the deliverable. It has to satisfy
two things: the same genome always draws the same animal, and two lineages are
visibly different creatures rather than the same blob in another colour.

## What is deliberately absent

No hunger, no decay, no neglect state, and no trait that gates an evolution. A
pet that punishes you for a week off, or for working the way you work, is a pet
you come to resent — and this one is attached to someone's actual job. It grows
when you work and waits when you don't.

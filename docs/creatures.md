# Creatures

A pixel creature per project, grown from that project's tokens and branched by
the kind of work that fed it. The header chip is this project's; the menagerie
is all of them.

This is the design record. The code is:

| Piece | File |
|---|---|
| the genome: stages, branches, rolls, names, sprite | `src/lib/creature.js` (pure) |
| assembling a project's history into that input | `src/stores/creatures.js` |
| the sprite renderer | `src/components/chat/CreatureSprite.vue` |
| the menagerie | `src/components/dialogs/MenagerieDialog.vue` |

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

## The sprite

Deterministic 16×16, mirrored down the spine, drawn as SVG rects so one genome
renders crisply at 14px in the header and 96px in the menagerie. Body size grows
with the stage (the most legible signal that something evolved, before any detail
is looked at); limbs appear at stage 2, crests at 3, a tail at 4; hue comes from
the current branch and is decoration only — every creature is captioned with its
type in words.

The art is crude on purpose. It has to satisfy exactly two things: the same
genome always draws the same body, and two lineages are visibly different animals
rather than the same blob in another colour.

## What is deliberately absent

No hunger, no decay, no neglect state, and no trait that gates an evolution. A
pet that punishes you for a week off, or for working the way you work, is a pet
you come to resent — and this one is attached to someone's actual job. It grows
when you work and waits when you don't.

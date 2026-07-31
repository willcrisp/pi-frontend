// One creature per project, grown from that project's token history and fed by
// its work profile.
//
// Nothing here decides what a creature IS — lib/creature.js does, purely. This
// module's whole job is assembling the input: walking a project's sessions
// oldest-first, cutting the token history at the stage thresholds, and asking
// the work profile what kind of work fed each of those windows.
//
// ── Why nothing is stored ────────────────────────────────────────────────────
// A creature is DERIVED, every time, from the session list the sidebar already
// has. There is no saved creature to migrate, corrupt, or lose, and a creature
// survives clearing localStorage, switching machines, and this file being
// rewritten — because the animal was never the state. Your history is.
//
// The one thing that genuinely cannot be derived is WHEN an evolution happened
// (the session list records when a session was last touched, not when a running
// total crossed a line), so that — and only that — is logged.
//
// ── The cost of deriving ─────────────────────────────────────────────────────
// Zero requests. Tokens come off `SessionV2.Info`, which `GET /session` already
// returned, and the work profile is whatever tier the user has already paid for:
// titles by default, transcripts or a model classification if they asked. A
// better profile makes for a better-branched creature, which is the nicest kind
// of upgrade path — the feature that costs nothing gets better if you feed it.
import { reactive } from "vue";
import { projectsStore, directoryLabel } from "./projects.js";
import { profileFor, workProfileStore } from "./workprofile.js";
import { CATEGORY_IDS, aggregate } from "../lib/workcategories.js";
import { STAGES, deriveGenome, stageFor } from "../lib/creature.js";
import { readJSON, writeJSON } from "../lib/storage.js";

const LOG_KEY = "opencode-web:creatures:lineageLog";

export const creaturesStore = reactive({
  // key (project directory) -> { stage, at, path, name }, the last evolution
  // seen for that project. See the header: the only underivable fact.
  log: readJSON(LOG_KEY, {}) || {},
});

function tokensOf(session) {
  const t = session.tokens || {};
  const cache = t.cache || {};
  return (t.input || 0) + (t.output || 0) + (cache.read || 0) + (cache.write || 0);
}

// The sessions that feed one project's creature, oldest first — which is the
// order they were lived in, and the only order in which a lineage means
// anything.
//
// Sub-agent sessions are excluded from the feed but counted for the `hive`
// trait: their tokens are already the parent task's work, and counting them
// twice would evolve a creature faster for having delegated.
function feedFor(directory) {
  const classifierID = workProfileStore.model.sessionID;
  const all = projectsStore.sessions || [];
  const subagents = all.filter((s) => s.parentID && s.directory === directory).length;

  const sessions = all
    .filter((s) => !s.parentID && s.id !== classifierID && s.directory === directory)
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

  return { sessions, subagents };
}

// Cut a project's history at the stage thresholds.
//
// A session that spans a threshold is credited to BOTH windows, in proportion to
// how many of its tokens landed either side. Its work — the scores — is whole in
// each; only the weight is split, because half a session is still the same kind
// of work, just less of it.
//
// The proportional split is not a detail. Assigning a spanning session whole to
// the window it ended in made the "what is it eating now" preview lag by an
// entire stage: the 500k session that TRIGGERED an evolution outweighed
// everything done since, so a creature that had spent a fortnight on docs still
// claimed it was branching testing. The preview is the part of this feature that
// is supposed to be actionable, and it was pointing backwards.
function windowsFor(sessions) {
  const windows = [];
  const ensure = (i) => {
    while (windows.length <= i) windows.push({ tokens: 0, entries: [] });
    return windows[i];
  };

  let running = 0;
  for (const session of sessions) {
    const tokens = tokensOf(session);
    const profile = profileFor(session.id);
    const from = stageFor(running).stage;
    const to = stageFor(running + tokens).stage;

    for (let i = from; i <= to; i++) {
      // How much of this session was consumed while the creature was at stage i.
      const lower = STAGES[i].at;
      const upper = STAGES[i + 1] ? STAGES[i + 1].at : Infinity;
      const share = Math.max(
        0,
        Math.min(running + tokens, upper) - Math.max(running, lower)
      );
      if (share <= 0 && tokens > 0) continue;
      const window = ensure(i);
      window.tokens += share;
      window.entries.push({ ...profile, tokens: share });
    }

    running += tokens;
  }

  return windows.map((w) => ({
    tokens: w.tokens,
    scores: w.entries.length ? aggregate(w.entries, (e) => Math.max(e.tokens, 1)).scores : null,
  }));
}

// The creature for one project directory.
export function creatureFor(directory) {
  const { sessions, subagents } = feedFor(directory);

  let tokens = 0;
  let cacheRead = 0;
  let output = 0;
  const lifetime = [];

  for (const session of sessions) {
    const t = session.tokens || {};
    tokens += tokensOf(session);
    cacheRead += t.cache?.read || 0;
    output += t.output || 0;
    lifetime.push({ ...profileFor(session.id), tokens: tokensOf(session) });
  }

  const windows = windowsFor(sessions);
  const stage = stageFor(tokens).stage;
  const lifetimeScores = aggregate(lifetime, (e) => Math.max(e.tokens, 1)).scores;

  const genome = deriveGenome({
    key: directory,
    // The birth seed. Tied to the project's oldest session rather than to its
    // path, so two people working in identically-named directories don't get
    // identical luck — and so a creature's rolls are as old as it is.
    originID: sessions[0]?.id || "",
    windows: windows.slice(0, stage),
    // What is feeding the stage in progress, and therefore which way the next
    // branch is currently bending.
    pending: windows[stage] || { tokens: 0, scores: null },
    tokens,
    stats: {
      cacheRead,
      output,
      sessions: sessions.length,
      subagents,
      categoriesTouched: CATEGORY_IDS.filter((id) => (lifetimeScores[id] || 0) > 0.05).length,
    },
  });

  return {
    ...genome,
    label: directoryLabel(directory),
    directory,
    sessionCount: sessions.length,
    lastActive: sessions[sessions.length - 1]?.updatedAt || 0,
    evolvedAt: creaturesStore.log[directory]?.at || 0,
  };
}

// Every project's creature, strongest first — the menagerie, and the catalogue
// of what kinds of work you actually do, one animal per project.
export function menagerie() {
  const classifierID = workProfileStore.model.sessionID;
  const directories = new Set();
  for (const s of projectsStore.sessions || []) {
    if (s.parentID || s.id === classifierID) continue;
    directories.add(s.directory || "");
  }
  return [...directories]
    .map(creatureFor)
    .sort((a, b) => b.stage - a.stage || b.tokens - a.tokens);
}

// Record any evolution that has happened since we last looked, and report the
// ones that are new. Called when a view that shows creatures opens — deliberately
// not from a computed, because writing to storage while rendering is how you get
// a render loop.
//
// Returns the creatures that evolved, so a caller can say so.
export function recordEvolutions() {
  const evolved = [];
  let dirty = false;

  for (const creature of menagerie()) {
    const seen = creaturesStore.log[creature.directory];
    if (seen && seen.stage >= creature.stage) continue;
    // A creature seen for the first time at stage 0 is not an evolution, it is
    // an egg — logged so the NEXT stage reads as an evolution, but not
    // announced as one.
    if (creature.stage > 0 && seen) evolved.push(creature);
    creaturesStore.log[creature.directory] = {
      stage: creature.stage,
      at: Date.now(),
      path: creature.path,
      name: creature.name,
    };
    dirty = true;
  }

  if (dirty) writeJSON(LOG_KEY, creaturesStore.log);
  return evolved;
}

// The creature for the project the user is looking at.
export function activeCreature(directory) {
  return creatureFor(directory || "");
}

export function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export { STAGES };

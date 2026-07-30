// The work-categorisation taxonomy: what the categories are, what evidence
// points at each of them, how evidence becomes a score, and the prompt that
// asks a model when the evidence is thin.
//
// Dependency-free on purpose, like markdown.js and fuzzy.js — everything here
// is a pure function over plain objects, so the rules can be read, tested and
// tuned without booting a store. stores/workprofile.js is what gathers the
// evidence and decides when to spend a request on the model.
//
// ⚠️ This file also owns the CLASSIFIER SESSION KEY. That looks out of place in
// a taxonomy module, and it is here for the reason CLAUDE.md gives: the model
// pass runs in a session of its own, and BOTH stores/workprofile.js (which
// creates and prompts it) and stores/projects.js (which must keep it out of the
// sidebar) need the id. If the key lived in either store, the other would have
// to import it and the two would form a cycle.

// --- The taxonomy ------------------------------------------------------------
//
// Eight axes, in a fixed order — the radar's spokes are laid out in this order
// and a session's stored scores are keyed by these ids, so REORDERING IS FINE
// but RENAMING AN ID INVALIDATES EVERY CACHED CLASSIFICATION. Bump
// TAXONOMY_VERSION when you do, which is what evicts the cache.
export const TAXONOMY_VERSION = 1;

export const CATEGORIES = [
  {
    id: "frontend",
    label: "Frontend",
    hint: "UI, components, styling, client-side behaviour",
  },
  {
    id: "backend",
    label: "Backend",
    hint: "Services, APIs, handlers, business logic",
  },
  {
    id: "data",
    label: "Data",
    hint: "Schemas, migrations, queries, pipelines, analysis",
  },
  {
    id: "infra",
    label: "Infra",
    hint: "Deploys, containers, CI, cloud plumbing",
  },
  {
    id: "security",
    label: "Security",
    hint: "Auth, secrets, hardening, vulnerabilities",
  },
  {
    id: "testing",
    label: "Testing",
    hint: "Tests, fixtures, coverage, chasing failures",
  },
  {
    id: "docs",
    label: "Docs",
    hint: "READMEs, guides, comments, write-ups",
  },
  {
    id: "tooling",
    label: "Tooling",
    hint: "Build config, dependencies, scripts, repo chores",
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export function categoryLabel(id) {
  return CATEGORIES.find((c) => c.id === id)?.label || id || "unclassified";
}

// --- The signals -------------------------------------------------------------
//
// Three channels of evidence, deliberately different in strength:
//
//   paths    — the strongest thing available. A turn that edited `Button.vue`
//              was frontend work whatever anyone called it in prose.
//   tools    — weak on its own (`read` says nothing), so only the few tools
//              that are themselves a kind of work are listed.
//   keywords — what the human ASKED for. Matched against the session title and
//              the user's prompts, never the assistant's replies: an agent
//              narrating "I'll add a test for the CSS change" would otherwise
//              drag every session towards testing.
//
// Patterns are matched case-insensitively against lowercased text, and each
// pattern can only score its category ONCE per channel (see `scoreChannel`) —
// otherwise a prompt that says "test" nine times outranks one that quietly
// rewrote the whole test suite.
const SIGNALS = {
  frontend: {
    paths: [
      /\.(vue|svelte|jsx|tsx)$/,
      /\.(css|scss|sass|less|styl)$/,
      /\.html?$/,
      /(^|\/)(components?|views?|pages?|styles?|ui|frontend|client|web)\//,
    ],
    keywords: [
      /\bui\b/,
      /\bcss\b/,
      /front[- ]?end/,
      /\bcomponent\b/,
      /\bstyl(e|es|ing)\b/,
      /\blayout\b/,
      /\bbutton\b/,
      /\bmodal\b|\bdialog\b/,
      /\bresponsive\b/,
      /\banimation\b|\btransition\b/,
      /\brender(ing)?\b/,
      /\baccessib/,
      /\bdark mode\b|\btheme\b/,
      /\breact\b|\bvue\b|\bsvelte\b|\btailwind\b/,
    ],
    tools: [],
  },
  backend: {
    paths: [
      /\.(go|rs|rb|php|cs|java|kt|ex|exs)$/,
      /(^|\/)(server|api|handlers?|controllers?|routes?|services?|middleware|backend)\//,
    ],
    keywords: [
      /\bapi\b/,
      /\bendpoint\b/,
      /\bserver\b/,
      /\broute\b|\brouting\b/,
      /\bhandler\b/,
      /\bmiddleware\b/,
      /back[- ]?end/,
      /\bmicroservice\b/,
      /\bgrpc\b|\brest\b|\bgraphql\b/,
      /\bqueue\b|\bworker\b|\bcron\b/,
      /\bwebhook\b/,
      /\brate[- ]?limit/,
      /\blatency\b|\bthroughput\b/,
    ],
    tools: [],
  },
  data: {
    paths: [
      /\.(sql|csv|tsv|parquet|avro|ipynb)$/,
      /(^|\/)(migrations?|schemas?|models?|queries|etl|data|analytics)\//,
    ],
    keywords: [
      /\bdatabase\b|\bdb\b/,
      /\bschema\b/,
      /\bmigration\b/,
      /\bquery\b|\bqueries\b/,
      /\bsql\b|\bpostgres\b|\bmysql\b|\bsqlite\b|\bmongo\b/,
      /\bindex(es|ing)?\b/,
      /\betl\b|\bpipeline\b/,
      /\bdataset\b|\bdataframe\b|\bpandas\b/,
      /\baggregat/,
      /\banalytics\b|\bmetrics\b/,
      /\bwarehouse\b|\bbigquery\b|\bsnowflake\b/,
    ],
    tools: [],
  },
  infra: {
    paths: [
      /(^|\/)dockerfile/,
      /docker-compose\.ya?ml$/,
      /\.tf$|\.tfvars$/,
      /(^|\/)\.github\/workflows\//,
      /(^|\/)(k8s|kubernetes|helm|charts|deploy|infra|terraform|ansible)\//,
      /(^|\/)(nginx|caddy)\.conf$/,
    ],
    keywords: [
      /\bdeploy(ment|ing)?\b/,
      /\bdocker\b|\bcontainer\b/,
      /\bkubernetes\b|\bk8s\b|\bhelm\b/,
      /\bterraform\b|\bansible\b/,
      /\bci\b|\bcd\b|\bpipeline run\b/,
      /\bcluster\b|\bnode pool\b/,
      /\bnginx\b|\bproxy\b|\bload balancer\b/,
      /\baws\b|\bgcp\b|\bazure\b|\bs3\b/,
      /\bprovision/,
      /\bstaging\b|\bproduction\b|\brollout\b/,
      /\bdns\b|\bcertificate\b|\btls cert/,
    ],
    tools: [],
  },
  security: {
    paths: [/(^|\/)(auth|security)\//, /\.pem$|\.key$/],
    keywords: [
      /\bsecurity\b|\bsecure\b/,
      /\bvulnerab/,
      /\bcve\b|\bexploit\b/,
      /\bxss\b|\bcsrf\b|\bssrf\b|\binjection\b/,
      /\bsanitiz|\bescap(e|ing) (user|input)/,
      /\bauth(entication|orization)?\b|\boauth\b|\bsso\b/,
      /\bsecret(s)?\b|\bcredential/,
      /\btoken\b|\bapi key\b/,
      /\bencrypt|\bhash(ing|ed)?\b|\btls\b|\bssl\b/,
      /\bpermission(s)?\b|\brbac\b/,
      /\bharden|\bthreat model|\baudit\b/,
      /\bleak(ed|ing)?\b/,
    ],
    tools: [],
  },
  testing: {
    paths: [
      /\.(spec|test)\.[jt]sx?$/,
      /_test\.(go|py|rb)$/,
      /(^|\/)(tests?|__tests__|e2e|spec)\//,
      /(^|\/)conftest\.py$/,
    ],
    keywords: [
      /\btest(s|ing|ed)?\b/,
      /\bspec(s)?\b/,
      /\bplaywright\b|\bcypress\b|\bjest\b|\bvitest\b|\bpytest\b|\bmocha\b/,
      /\bcoverage\b/,
      /\bflaky\b/,
      /\bassert(ion)?\b|\bexpect\b/,
      /\bfixture\b|\bmock\b|\bstub\b/,
      /\bregression\b/,
      /\breproduce\b|\brepro\b/,
    ],
    tools: [],
  },
  docs: {
    paths: [/\.(md|mdx|rst|adoc)$/, /(^|\/)docs?\//, /(^|\/)readme/, /(^|\/)changelog/],
    keywords: [
      /\bdocument(ation|ing|ed)?\b/,
      /\bdocs\b|\breadme\b|\bchangelog\b/,
      /\bwrite[- ]?up\b|\bwrite up\b/,
      /\bguide\b|\btutorial\b|\bwalkthrough\b/,
      /\bexplain\b|\bsummaris|\bsummariz/,
      /\bcomment(s|ing)?\b/,
      /\brelease notes\b/,
      /\bhandover\b|\bhand-off\b/,
      /\bdiagram\b/,
    ],
    tools: [],
  },
  tooling: {
    paths: [
      /(^|\/)package(-lock)?\.json$/,
      /(^|\/)(pnpm-lock|yarn\.lock|cargo\.(toml|lock)|go\.(mod|sum)|requirements\.txt|pyproject\.toml|gemfile)/,
      /(^|\/)(vite|webpack|rollup|esbuild|babel|jest|playwright|tsconfig|eslintrc|prettierrc)/,
      /(^|\/)makefile$/,
      /(^|\/)scripts?\//,
    ],
    keywords: [
      /\bbuild\b|\bbundler?\b/,
      /\blint(er|ing)?\b|\bformat(ter|ting)?\b/,
      /\bdependenc(y|ies)\b|\bupgrade\b|\bbump\b/,
      /\bnpm\b|\byarn\b|\bpnpm\b|\bcargo\b/,
      /\bmonorepo\b|\bworkspace\b/,
      /\bconfig(uration|ure)?\b/,
      /\bscript\b|\bmakefile\b/,
      /\btooling\b|\bdevex\b|\bdeveloper experience\b/,
      /\brefactor\b|\btidy\b|\bclean ?up\b/,
    ],
    tools: [],
  },
};

// How much each channel is worth. A file path is what actually happened; a word
// in a prompt is what someone meant to happen, and those are not equally true.
const WEIGHTS = { path: 3, tool: 2, title: 2.5, prompt: 1 };

// Below this much total evidence a heuristic classification is a guess, and the
// UI says so (and the model pass offers to do better). Two path matches, or a
// title match plus a prompt match, clears it.
export const WEAK_EVIDENCE = 3;

// --- Evidence -> scores ------------------------------------------------------

function emptyScores() {
  return Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0]));
}

// Score one channel: every pattern that matches ANYWHERE in `haystack` adds its
// weight once. Deliberately not per-occurrence — see the SIGNALS comment.
function scoreChannel(raw, haystack, key, weight) {
  if (!haystack) return;
  for (const id of CATEGORY_IDS) {
    for (const pattern of SIGNALS[id][key]) {
      if (pattern.test(haystack)) raw[id] += weight;
    }
  }
}

// Pull path-like tokens out of arbitrary text — a stringified tool input, a
// prompt, a bash command line. Anything with a slash or a file extension is a
// candidate; the SIGNALS path patterns do the actual discriminating, so being
// generous here costs nothing and being narrow loses the best signal we have.
export function extractPaths(text) {
  if (!text) return [];
  const found = String(text).match(/[\w.@\/-]*[\w-]+\.[a-z]{1,6}\b|[\w.-]+\/[\w.\/-]+/gi);
  if (!found) return [];
  // Dedupe and drop the obvious non-paths a loose regex picks up (version
  // numbers, "e.g.", bare domains).
  const out = new Set();
  for (const token of found) {
    const t = token.toLowerCase();
    if (t.length < 3 || /^\d+\.\d+/.test(t) || /^(e\.g|i\.e|etc)\b/.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

// Classify one session's evidence.
//
//   evidence = { title, prompts: string[], files: string[], tools: string[] }
//
// Returns `{ scores, raw, total, weak }` where `scores` sums to 1 (a session's
// MIX of work), or to 0 when nothing matched at all. Callers must handle the
// all-zero case rather than dividing by it: "we couldn't tell" is a real and
// common answer, and painting it as an even eight-way split would be a lie the
// radar tells very convincingly.
export function classify(evidence = {}) {
  const raw = emptyScores();
  const title = (evidence.title || "").toLowerCase();
  const prompts = (evidence.prompts || []).join("\n").toLowerCase();
  const files = (evidence.files || []).join("\n").toLowerCase();
  const tools = (evidence.tools || []).join("\n").toLowerCase();

  scoreChannel(raw, title, "keywords", WEIGHTS.title);
  scoreChannel(raw, prompts, "keywords", WEIGHTS.prompt);
  scoreChannel(raw, files, "paths", WEIGHTS.path);
  scoreChannel(raw, tools, "tools", WEIGHTS.tool);

  return finalize(raw);
}

function finalize(raw) {
  const total = CATEGORY_IDS.reduce((sum, id) => sum + raw[id], 0);
  const scores = emptyScores();
  if (total > 0) {
    for (const id of CATEGORY_IDS) scores[id] = raw[id] / total;
  }
  return { scores, raw, total, weak: total < WEAK_EVIDENCE };
}

// The single category a set of scores is mostly about, or null when there is no
// evidence. Ties break on taxonomy order, which is stable — a session must not
// change its label between two renders of the same data.
export function dominant(scores) {
  if (!scores) return null;
  let best = null;
  for (const id of CATEGORY_IDS) {
    if ((scores[id] || 0) <= 0) continue;
    if (!best || scores[id] > scores[best]) best = id;
  }
  return best;
}

// Sum a set of per-session profiles into one, each weighted by `weightOf`.
// Re-normalised at the end so the aggregate is a mix on the same 0..1 scale as
// its parts and the radar can draw both without a second scale.
export function aggregate(entries, weightOf = () => 1) {
  const raw = emptyScores();
  let counted = 0;
  for (const entry of entries) {
    if (!entry || !entry.scores) continue;
    const weight = Math.max(0, weightOf(entry) || 0);
    if (!weight) continue;
    let any = false;
    for (const id of CATEGORY_IDS) {
      const v = entry.scores[id] || 0;
      if (v > 0) any = true;
      raw[id] += v * weight;
    }
    if (any) counted += 1;
  }
  return { ...finalize(raw), counted };
}

// --- The model pass ----------------------------------------------------------

// Where the classifier session's id is remembered. See the file header for why
// this lives here.
export const CLASSIFIER_SESSION_KEY = "opencode-web:workprofile:classifierSession";

// The marker the mock (and a human reading the classifier session) can key off,
// and the thing that makes a classification prompt recognisable in a transcript.
export const CLASSIFIER_PREAMBLE = "You are a work classifier.";

// The prompt. Small on purpose: it is sent once per session being classified and
// the answer is machine-read, so every extra sentence is tokens spent on nothing.
//
// Two rules earn their words. "Only categories from this list" stops a model
// inventing `devops` and losing the score to a key nobody reads, and "omit
// rather than guess" is what keeps an ambiguous session honestly thin instead of
// evenly smeared across all eight axes.
export function buildClassifierPrompt(evidence = {}) {
  const lines = [
    CLASSIFIER_PREAMBLE,
    "Read the coding session below and estimate how its effort splits across these categories:",
    "",
    ...CATEGORIES.map((c) => `- ${c.id}: ${c.hint}`),
    "",
    "Reply with ONLY a JSON object mapping category id to an integer 0-100 (they need",
    "not sum to 100). Use only ids from the list. Omit a category rather than guess at",
    "it. No prose, no code fence, no explanation.",
    "",
    "--- SESSION ---",
    `title: ${evidence.title || "(untitled)"}`,
  ];

  const prompts = (evidence.prompts || []).filter(Boolean).slice(0, 8);
  if (prompts.length) {
    lines.push("what the user asked for:");
    for (const p of prompts) lines.push(`- ${truncate(p, 300)}`);
  }
  const files = (evidence.files || []).slice(0, 25);
  if (files.length) lines.push(`files touched: ${files.join(", ")}`);
  const tools = (evidence.tools || []).slice(0, 15);
  if (tools.length) lines.push(`tools used: ${tools.join(", ")}`);

  return lines.join("\n");
}

function truncate(text, max) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Read a classifier reply. Tolerant by design: a model that ignores "no code
// fence" and wraps the object in ```json is still telling us the right thing,
// and the alternative — dropping a paid-for answer on a formatting technicality
// — is the worse failure. Returns the same shape as classify(), or null when
// there is nothing usable in the text at all.
export function parseClassifierReply(text) {
  if (!text) return null;
  const match = String(text).match(/\{[^{}]*\}/);
  if (!match) return null;

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const raw = emptyScores();
  let any = false;
  for (const id of CATEGORY_IDS) {
    const v = Number(parsed[id]);
    // A model asked for 0-100 occasionally answers 0-1. Both are read the same
    // way here because everything is re-normalised into a mix below, so the
    // scale it chose never actually matters — only the ratios do.
    if (Number.isFinite(v) && v > 0) {
      raw[id] = v;
      any = true;
    }
  }
  if (!any) return null;
  return finalize(raw);
}

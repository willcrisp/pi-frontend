// What KIND of work you have been doing, per session and in aggregate — the
// data behind the radar in WorkProfileDialog.vue.
//
// Three tiers, in ascending order of what they cost. Each one only exists
// because the tier below it is not good enough on its own, and every tier above
// the first is something the user asks for rather than something that happens:
//
//   1. TITLE PASS — free, instant, no request. Every session already has a
//      server-written title in the sidebar's list, so the whole history can be
//      classified the moment the dialog opens. It is also the weakest evidence
//      there is: "Fix the thing" classifies as nothing at all, which is why the
//      radar labels how much of what it draws is only title-deep.
//
//   2. TRANSCRIPT SCAN — one GET /session/:id/message per session. Reads what
//      the user actually asked for and, far more tellingly, WHICH FILES THE
//      TOOLS TOUCHED. A session titled "Fix the thing" that edited four .vue
//      files and a stylesheet is not ambiguous at all once you look.
//
//   3. MODEL PASS — opt-in, costs tokens. Sends a compact digest of a session to
//      a model and reads back a JSON split (lib/workcategories.js owns the
//      prompt). For the sessions the regexes genuinely can't call — and only
//      those: it runs on the weak ones by default, not on everything.
//
// Results from tiers 2 and 3 are cached in localStorage against a fingerprint of
// the session, so reopening the dialog is free and a scan is paid for once.
//
// ── The classifier session ───────────────────────────────────────────────────
// The model pass needs somewhere to run, and V2 has no session delete — so a
// scratch session per classification would silently fill the sidebar with
// rubbish nobody can remove. Instead ONE session is created, remembered by id,
// and reused forever; projects.js hides it from the sidebar (it is a machine's
// scratchpad, not a chat) and it is excluded from the profile itself, since
// classifying is not work you did.
import { reactive } from "vue";
import { opencodeStore } from "./opencode/state.js";
import { fetchSessionMessages } from "./opencode/messages.js";
import { postPrompt } from "./opencode/transport.js";
import { selectedModelRef } from "./opencode/models.js";
import { projectsStore, fetchSessions } from "./projects.js";
import { apiPost } from "../lib/api.js";
import { readJSON, writeJSON, readString, writeString } from "../lib/storage.js";
import {
  CLASSIFIER_SESSION_KEY,
  TAXONOMY_VERSION,
  aggregate,
  buildClassifierPrompt,
  classify,
  dominant,
  extractPaths,
  parseClassifierReply,
} from "../lib/workcategories.js";

const CACHE_KEY = "opencode-web:workprofile:cache";
const WEIGHT_KEY = "opencode-web:workprofile:weight";

// Read at module load and written back on every change. Version-stamped: the
// scores are keyed by taxonomy id, so a taxonomy change makes every cached entry
// meaningless rather than merely stale, and silently drawing the old ones on the
// new axes would be worse than re-scanning.
function loadCache() {
  const stored = readJSON(CACHE_KEY, null);
  if (!stored || stored.v !== TAXONOMY_VERSION || typeof stored.entries !== "object") return {};
  return stored.entries || {};
}

export const workProfileStore = reactive({
  // sessionID -> { scores, source: "transcript"|"model", fingerprint, at, weak }
  // Title-pass results are NOT in here: they are recomputed from the session
  // list in microseconds and caching them would only create a way for a stale
  // one to outlive the title it came from.
  cache: loadCache(),
  // How the aggregate weights each session: "sessions" (one chat, one vote) or
  // "tokens" (where the context window actually went).
  weight: readString(WEIGHT_KEY, "tokens"),
  scan: { busy: false, done: 0, total: 0, error: null },
  model: { busy: false, done: 0, total: 0, error: null, sessionID: readString(CLASSIFIER_SESSION_KEY) },
});

function persist() {
  writeJSON(CACHE_KEY, { v: TAXONOMY_VERSION, entries: workProfileStore.cache });
}

export function setWeight(weight) {
  workProfileStore.weight = weight === "sessions" ? "sessions" : "tokens";
  writeString(WEIGHT_KEY, workProfileStore.weight);
}

// A session's fingerprint. Changes when the session has been worked on since it
// was classified — which marks a cached entry `stale` but never discards it: a
// model classification was paid for, and throwing it away automatically would
// re-spend that money on every refresh.
function fingerprintOf(session) {
  return `${session?.updatedAt || 0}`;
}

// --- Evidence ----------------------------------------------------------------

// Turn a normalized transcript (the shape stores/opencode/messages.js produces,
// live or restored) into the evidence classify() wants.
//
// Only the USER's turns contribute prose. The assistant's replies are excluded
// on purpose: an agent narrating "I'll add a test for this CSS change" would
// otherwise pull the session towards testing on the strength of its own
// commentary. Its TOOL CALLS are read though — those are the record of what was
// actually done, and they are the best evidence available anywhere.
export function evidenceFromMessages(title, messages) {
  const prompts = [];
  const files = new Set();
  const tools = new Set();

  for (const msg of messages || []) {
    if (msg.role === "user" && msg.text) {
      prompts.push(msg.text);
      for (const path of extractPaths(msg.text)) files.add(path);
    }
    for (const part of msg.parts || []) {
      if (part.type !== "tool") continue;
      if (part.tool) tools.add(part.tool);
      if (part.input) {
        // Every tool names its path argument differently (file_path, path,
        // notebook_path, or buried in a bash command line), so read the whole
        // input as text rather than keeping a list of key names that will be
        // wrong for the next tool that ships.
        try {
          for (const path of extractPaths(JSON.stringify(part.input))) files.add(path);
        } catch {
          /* circular or otherwise unserialisable input — nothing to read */
        }
      }
    }
  }

  return {
    title: title || "",
    // The last prompts, not the first: a long session's most recent turns are
    // what it is about by the end, and the digest sent to the model is capped.
    prompts: prompts.slice(-20),
    files: [...files].slice(-200),
    tools: [...tools],
  };
}

// --- Reading a profile back --------------------------------------------------

function sessionByID(sessionID) {
  return (projectsStore.sessions || []).find((s) => s.id === sessionID) || null;
}

// The best profile held for one session: a cached scan or model answer if there
// is one, otherwise the free title pass. Always returns something — `source`
// says how much to trust it.
export function profileFor(sessionID) {
  const session = sessionByID(sessionID);
  const cached = workProfileStore.cache[sessionID];
  if (cached) {
    return {
      ...cached,
      sessionID,
      stale: !!session && cached.fingerprint !== fingerprintOf(session),
      top: dominant(cached.scores),
    };
  }
  const result = classify({ title: session?.title || "" });
  return {
    sessionID,
    scores: result.scores,
    weak: result.weak,
    source: "title",
    at: 0,
    stale: false,
    top: dominant(result.scores),
  };
}

// The session on screen, classified from the transcript already in memory — no
// request, and it re-runs as the turn streams so the header chip is live.
//
// Memoised on a cheap fingerprint (how many messages, and how many parts the
// last one has) rather than the text: during a run the text changes on every
// delta, which would re-run every regex in the taxonomy tens of times a second
// for an answer that cannot meaningfully differ. A new part — a tool call, a new
// message — is the thing that actually carries new evidence.
let liveMemo = { key: "", value: null };

export function activeProfile() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return null;
  const messages = opencodeStore.messages || [];
  const last = messages[messages.length - 1];
  const key = `${sessionID}:${messages.length}:${(last?.parts || []).length}`;
  if (liveMemo.key === key) return liveMemo.value;

  const session = sessionByID(sessionID);
  const evidence = evidenceFromMessages(session?.title || "", messages);
  const result = classify(evidence);
  // A cached model answer is better than anything derivable here, so it wins —
  // but only while the session hasn't moved on since.
  const cached = workProfileStore.cache[sessionID];
  const useCached =
    cached && cached.source === "model" && cached.fingerprint === fingerprintOf(session);

  const value = useCached
    ? { ...cached, sessionID, source: "model", top: dominant(cached.scores) }
    : {
        sessionID,
        scores: result.scores,
        weak: result.weak,
        source: messages.length ? "live" : "title",
        top: dominant(result.scores),
      };
  liveMemo = { key, value };
  return value;
}

// --- The scope the dialog draws ---------------------------------------------

// Every session in scope, with its profile, plus the aggregate radar shape.
//
// `directory` narrows to one project, `days` to a time window (0 = all time).
// Sub-agent sessions are folded out: their work is the parent's work, dispatched,
// and counting both would double every task that used one.
export function profileScope({ directory = "", days = 0 } = {}) {
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const classifierID = workProfileStore.model.sessionID;

  const entries = (projectsStore.sessions || [])
    .filter((s) => !s.parentID)
    .filter((s) => s.id !== classifierID)
    .filter((s) => !directory || s.directory === directory)
    .filter((s) => !cutoff || (s.updatedAt || 0) >= cutoff)
    .map((s) => {
      const profile = profileFor(s.id);
      const t = s.tokens || {};
      const cache = t.cache || {};
      return {
        ...profile,
        title: s.title,
        directory: s.directory,
        updatedAt: s.updatedAt,
        cost: s.cost || 0,
        tokens: (t.input || 0) + (t.output || 0) + (cache.read || 0) + (cache.write || 0),
      };
    });

  const byTokens = workProfileStore.weight === "tokens";
  // Falls back to equal weighting when nothing is metered — a provider without
  // pricing reports 0 tokens on some builds, and weighting by 0 would draw an
  // empty radar over a history full of work.
  const metered = entries.some((e) => e.tokens > 0);
  const useTokens = byTokens && metered;
  const weightOf = useTokens ? (e) => e.tokens : () => 1;

  const total = aggregate(entries, weightOf);
  const classified = entries.filter((e) => e.top);

  return {
    entries: entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    aggregate: total,
    classified: classified.length,
    unclassified: entries.length - classified.length,
    // How much of the shape rests on a title alone — the honest caveat on the
    // chart, and the thing the "Scan transcripts" button improves.
    titleOnly: entries.filter((e) => e.source === "title").length,
    weightedBy: useTokens ? "tokens" : "sessions",
  };
}

// The same aggregate for a subset, used to overlay one project on the whole
// history. Returns null when the subset is the whole thing, so the caller can
// skip drawing two identical polygons on top of each other.
export function compareScope(directory) {
  if (!directory) return null;
  const all = (projectsStore.sessions || []).filter((s) => !s.parentID);
  if (!all.some((s) => s.directory !== directory)) return null;
  return profileScope({ directory });
}

// --- Tier 2: the transcript scan --------------------------------------------

// Fetch and classify the transcripts of `sessionIDs`, skipping any already
// scanned at the same fingerprint (unless `force`). Bounded concurrency: this
// runs against someone's real server, and firing 200 requests at it because a
// history is long would be a denial of service we wrote ourselves.
const SCAN_CONCURRENCY = 4;

export async function scanTranscripts(sessionIDs, { force = false } = {}) {
  if (workProfileStore.scan.busy) return;
  const session = (id) => sessionByID(id);
  const pending = sessionIDs.filter((id) => {
    if (force) return true;
    const cached = workProfileStore.cache[id];
    return !cached || cached.fingerprint !== fingerprintOf(session(id));
  });

  workProfileStore.scan = { busy: true, done: 0, total: pending.length, error: null };
  if (!pending.length) {
    workProfileStore.scan.busy = false;
    return;
  }

  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const messages = await fetchSessionMessages(id);
        // null is "the request failed", which is not the same as "this chat is
        // empty" — recording an empty classification for it would cache a
        // network blip as a fact about someone's work.
        if (messages) {
          const evidence = evidenceFromMessages(session(id)?.title || "", messages);
          const result = classify(evidence);
          workProfileStore.cache[id] = {
            scores: result.scores,
            weak: result.weak,
            source: "transcript",
            fingerprint: fingerprintOf(session(id)),
            at: Date.now(),
          };
        }
      } catch (err) {
        workProfileStore.scan.error = err.message || "Couldn't read a transcript";
      } finally {
        workProfileStore.scan.done += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  persist();
  workProfileStore.scan.busy = false;
}

// --- Tier 3: the model pass --------------------------------------------------

const REPLY_TIMEOUT_MS = 90_000;
const REPLY_POLL_MS = 1500;

// The session the classifier runs in, created on first use and reused after.
// Verified against the session list rather than trusted from localStorage: the
// stored id may belong to a different server entirely (the connect dialog can be
// repointed at any port), and prompting a stranger's session would be both
// confusing and rude.
async function classifierSession() {
  const stored = workProfileStore.model.sessionID;
  if (stored && sessionByID(stored)) return stored;

  const body = {};
  const modelRef = selectedModelRef();
  if (modelRef) body.model = modelRef;
  const res = await apiPost("/session", body);
  if (!res.ok) throw new Error(`Couldn't create the classifier session (${res.status})`);
  const payload = await res.json();
  const id = payload?.data?.id || payload?.id;
  if (!id) throw new Error("The server created no classifier session");

  workProfileStore.model.sessionID = id;
  writeString(CLASSIFIER_SESSION_KEY, id);
  // So the sidebar filter (projects.js#rootSessions) has the record it needs to
  // hide, rather than showing the new session until the next refresh happens by.
  await fetchSessions();
  return id;
}

// Wait for the classifier's answer.
//
// Polled rather than read off the SSE stream, which is the cheaper-looking
// option and the wrong one: events.js routes events by session into the
// transcript of the chat ON SCREEN, and the classifier's session is deliberately
// not that. Teaching the reducer about a session the user can't see, so this
// module could listen for it, would put a machine's bookkeeping in the middle of
// the code that renders chats. Polling a session nobody is watching, for the
// duration of one classification, stays entirely inside this file.
async function awaitReply(sessionID, baselineCount) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, REPLY_POLL_MS));
    const messages = await fetchSessionMessages(sessionID);
    if (!messages) continue;
    for (const msg of messages.slice(baselineCount)) {
      if (msg.role !== "assistant" || !msg.text) continue;
      const parsed = parseClassifierReply(msg.text);
      if (parsed) return parsed;
    }
  }
  return null;
}

// Classify sessions with the model, one at a time.
//
// Sequential on purpose. Every prompt goes to the same session, and the agent
// loop there runs one turn at a time — firing them together would just admit
// them all as steers into the first run, and a steered prompt is read as a
// follow-up to what came before it, which for a classifier means the second
// answer is contaminated by the first session's evidence.
export async function classifyWithModel(sessionIDs) {
  if (workProfileStore.model.busy) return;
  workProfileStore.model = {
    ...workProfileStore.model,
    busy: true,
    done: 0,
    total: sessionIDs.length,
    error: null,
  };

  try {
    const classifierID = await classifierSession();

    for (const id of sessionIDs) {
      const session = sessionByID(id);
      if (!session) {
        workProfileStore.model.done += 1;
        continue;
      }
      try {
        // Evidence for the digest: whatever the scan already read, or the
        // transcript now. The model is being paid for either way, so it is worth
        // one GET to make sure it is answering about something real.
        const messages = (await fetchSessionMessages(id)) || [];
        const evidence = evidenceFromMessages(session.title || "", messages);

        const before = (await fetchSessionMessages(classifierID)) || [];
        const res = await postPrompt(
          classifierID,
          { text: buildClassifierPrompt(evidence) },
          // Queued, not steered: each classification is its own turn with its
          // own answer, and steering would merge them into one.
          { delivery: "queue" }
        );
        if (!res.ok) throw new Error(`The classifier rejected the prompt (${res.status})`);

        const parsed = await awaitReply(classifierID, before.length);
        if (!parsed) throw new Error("The classifier didn't answer in time");

        workProfileStore.cache[id] = {
          scores: parsed.scores,
          weak: parsed.weak,
          source: "model",
          fingerprint: fingerprintOf(session),
          at: Date.now(),
        };
        persist();
      } catch (err) {
        // One session failing must not abandon the rest of the batch — the
        // failures are reported together at the end.
        workProfileStore.model.error = err.message || "A classification failed";
      } finally {
        workProfileStore.model.done += 1;
      }
    }
  } catch (err) {
    workProfileStore.model.error = err.message || "Couldn't run the classifier";
  } finally {
    workProfileStore.model.busy = false;
  }
}

// Sessions worth spending the model on: the ones the regexes couldn't call.
// Offered rather than assumed — see the header on why tier 3 is opt-in.
export function weakSessions(entries) {
  return entries.filter((e) => e.source !== "model" && (!e.top || e.weak)).map((e) => e.sessionID);
}

// A stand-in for `opencode2 serve`, used by the Playwright tests.
//
// It implements just enough of the V2 HttpApi to boot the frontend: health, the
// four catalogs, a session list, an empty transcript, an SSE stream that stays
// open, and an agent loop that answers a prompt. It is NOT a fidelity model of
// the real server — the point is to exercise OUR code (stores, composables,
// components) without needing a live agent, so responses are the minimum shape
// docs/opencode-api.md says each route returns.
//
// The one place fidelity does matter is the shape of a turn: see "The agent
// loop" below, which follows a sequence captured from a live server, because the
// frontend's idea of when a run has finished is derived from it.
//
// If a test needs a route this doesn't have, add it here rather than mocking at
// the network layer in the spec — one obvious server beats per-test stubs.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT) || 4096;

const json = (res, body) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// The directory the tests seed the file-search cache against.
const DIRECTORY = "/home/user/pi-frontend";

// Two sessions in one project, so the sidebar has something to switch between —
// which is what per-session composer drafts need in order to be testable.
//
// Both are metered: SessionV2.Info carries `cost` and `tokens`, which is the
// only source the usage view has for anything but the session on screen. The
// timestamps are real milliseconds so day-bucketing lands in this decade rather
// than 1970 — ordering (mock1 newer than mock2) is what the sidebar tests rely
// on, and that still holds.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-30T12:00:00Z");

const SESSIONS = [
  {
    id: "ses_mock1",
    title: "Mock session",
    time: { created: NOW - DAY, updated: NOW },
    location: { directory: DIRECTORY },
    cost: 0.42,
    tokens: { input: 18400, output: 5200, cache: { read: 9100, write: 2300 } },
  },
  {
    id: "ses_mock2",
    title: "Second session",
    time: { created: NOW - 2 * DAY, updated: NOW - DAY },
    location: { directory: DIRECTORY },
    cost: 0.17,
    tokens: { input: 7300, output: 2100, cache: { read: 1200, write: 400 } },
  },
];

// A longer, multi-project history, added only when a test asks for it via
// /api/mock/control {richHistory: true}. The default list stays at two entries
// because several specs count the sidebar's rows.
const EXTRA_SESSIONS = [
  ["Refactor the parser", 1.86, 61000, 3, "/home/user/pi-frontend"],
  ["Chase a flaky test", 0.94, 32000, 4, "/home/user/pi-frontend"],
  ["Draft the release notes", 0.31, 11000, 5, "/home/user/notes"],
  ["Port the auth middleware", 2.41, 88000, 6, "/home/user/api-gateway"],
  ["Investigate the latency spike", 1.12, 40000, 7, "/home/user/api-gateway"],
  ["Tidy the CI workflow", 0.22, 8000, 9, "/home/user/notes"],
].map(([title, cost, total, daysAgo, directory], i) => ({
  id: `ses_hist${i + 1}`,
  title,
  time: { created: NOW - (daysAgo + 1) * DAY, updated: NOW - daysAgo * DAY },
  location: { directory },
  cost,
  tokens: {
    input: Math.round(total * 0.7),
    output: Math.round(total * 0.2),
    cache: { read: Math.round(total * 0.1), write: 0 },
  },
}));

// A project with enough tokens on it to actually evolve a creature, added only
// when a test asks for it via /api/mock/control {creatureHistory: true}.
//
// The order and the sizes are the fixture: the creature's stage comes from the
// running token total, and each branch comes from the work that fed the stage it
// was in. So these are laid out to grow one deliberate lineage —
//
//   0 →  25k   frontend   two small UI sessions
//   25k → 150k security   the credential audit
//   150k → 750k data      the schema work
//   750k → 3m  testing    a long fight with the suite
//   3m →       docs       what it is eating now, so the NEXT branch is docs
//
// — which is the assertion in test/creatures.spec.js. Titles are chosen to be
// callable by the free title pass, since these sessions have no transcript.
const CREATURE_DIR = "/home/user/atlas";
const CREATURE_SESSIONS = [
  ["Rebuild the settings UI component", 12_000, 30],
  ["Restyle the dashboard layout", 16_000, 29],
  ["Audit the leaked credentials", 40_000, 27],
  ["Harden the session cookie", 45_000, 26],
  ["Encrypt the stored secrets", 40_000, 25],
  ["Add the migration for the events schema", 200_000, 22],
  ["Index the analytics queries", 220_000, 21],
  ["Backfill the warehouse dataset", 200_000, 20],
  ["Chase the flaky spec suite", 600_000, 16],
  ["Add coverage for the parser tests", 700_000, 15],
  ["Fix the fixture teardown in the e2e specs", 500_000, 14],
  ["Stabilise the assertion helpers", 500_000, 13],
  ["Write the release notes", 100_000, 8],
  ["Document the handover guide", 90_000, 7],
].map(([title, total, daysAgo], i) => ({
  id: `ses_crt${i + 1}`,
  title,
  time: { created: NOW - (daysAgo + 1) * DAY, updated: NOW - daysAgo * DAY },
  location: { directory: CREATURE_DIR },
  cost: total / 400_000,
  // Cache-heavy, the way a real long session is — which is also what earns the
  // "Efficient" trait, so the trait row has something in it.
  tokens: {
    input: Math.round(total * 0.25),
    output: Math.round(total * 0.05),
    cache: { read: Math.round(total * 0.65), write: Math.round(total * 0.05) },
  },
}));

// Two models so the picker has something to rank and colour: MODEL_RANK puts
// "sol" above "luna", and only Sol carries variants.
const MODELS = [
  {
    providerID: "acme",
    id: "sol-1",
    name: "Sol",
    limit: { context: 200000 },
    variants: ["low", "high", "max"],
  },
  { providerID: "acme", id: "luna-1", name: "Luna", limit: { context: 100000 }, variants: ["low", "high"] },
];

const AGENTS = [
  { id: "build", name: "Build", mode: "primary", description: "builds things" },
  { id: "plan", name: "Plan", mode: "secondary", description: "plans things" },
  // mode:"subagent" must be filtered out of the composer's agent picker.
  { id: "explore", name: "Explore", mode: "subagent" },
];

// A transcript for the first session only, carrying the things the transcript
// tests need real components to render: a fenced code block (for the markdown
// copy button), an edit-shaped tool call (for the diff view), and user prompts
// either side of it (for the prompt rail and its fork button). The second
// session stays empty, so the draft test switches into a clean chat.
//
// Keep the word "const" out of the user turns — the FindBar test counts its
// matches in the code block.
const TRANSCRIPT = {
  ses_mock1: [
    { id: "msg_u1", type: "user", time: { created: 5 }, text: "show me a snippet" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 10 },
      content: [
        { type: "text", text: "Here is the snippet:\n\n```js\nconst x = 1;\nconst y = 2;\n```\n" },
        {
          type: "tool",
          name: "edit",
          id: "call_edit_1",
          state: {
            status: "completed",
            input: {
              file_path: `${DIRECTORY}/README.md`,
              old_string: "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf",
              new_string: "alpha\nbravo\nCHARLIE\ndelta\necho\nfoxtrot\ngolf",
            },
            content: [{ type: "text", text: "edited" }],
          },
        },
      ],
    },
    { id: "msg_u2", type: "user", time: { created: 20 }, text: "now rename the file" },
  ],
};

const BASE_SESSION_COUNT = SESSIONS.length;
const BASE_TRANSCRIPT_LENGTHS = Object.fromEntries(
  Object.entries(TRANSCRIPT).map(([id, list]) => [id, list.length])
);
let nextSessionSeq = 3;

// Sessions a test created — and turns a test sent — are dropped when the next
// page loads (a client opening the event stream is the signal). One worker runs
// the suite serially, so this is the cheap equivalent of a per-test server: the
// fork test creates a session and asserts against it, and the next test still
// sees the two seeded ones with their two seeded prompts — which several of
// them count.
// What the *data* looks like, as opposed to how the stream behaves. Kept out of
// `control` because control is reset whenever a client opens the event stream,
// and the session list is fetched during that same page load — a seed reset on
// connect could never be in effect for the fetch it is meant to shape. Tests
// that set this clear it themselves.
const seed = {
  // Adds EXTRA_SESSIONS to the session list, so the usage view has a history
  // worth charting. Off by default: specs count the sidebar's rows.
  richHistory: false,
  // Adds CREATURE_SESSIONS — a project with millions of tokens on it, which is
  // what a creature needs to be past its first stage. Same reasoning: off by
  // default so it doesn't move every other spec's counts.
  creatureHistory: false,
};

function resetCreatedSessions() {
  SESSIONS.length = BASE_SESSION_COUNT;
  for (const id of Object.keys(TRANSCRIPT)) {
    if (BASE_TRANSCRIPT_LENGTHS[id] === undefined) delete TRANSCRIPT[id];
    else TRANSCRIPT[id].length = BASE_TRANSCRIPT_LENGTHS[id];
  }
  // Agent-loop state and anything a test set through /api/mock/control go with
  // them, so a spec never inherits the previous one's event vocabulary.
  running.clear();
  steered.clear();
  Object.assign(control, DEFAULT_CONTROL);
}

// Session create. The real route takes `{agent?, model?, location?}` and answers
// with the new session; only the id is load-bearing for us. Registering it in
// SESSIONS keeps the sidebar and the transcript route consistent afterwards.
function createSession(res) {
  const session = {
    id: `ses_mock${nextSessionSeq++}`,
    title: "New session",
    time: { created: 30, updated: 30 },
    location: { directory: DIRECTORY },
  };
  // Appended, never prepended: resetCreatedSessions truncates the tail.
  SESSIONS.push(session);
  return json(res, { data: session });
}

// --- Prompting ---------------------------------------------------------------
//
// The one held-open SSE response, so a prompt can be answered on it. Only one
// page is ever driving this server (a single Playwright worker), so one is
// enough — a second connection replaces the first.
let eventStream = null;
let nextEventSeq = 2;

function emit(type, data) {
  if (!eventStream) return;
  eventStream.write(`data: ${JSON.stringify({ id: `e${nextEventSeq++}`, type, data })}\n\n`);
}

// The canned agent. A real one is what the frontend is missing here, and
// several features (steering, and the handover document /handover asks for) are
// only exercisable against a turn that actually answers — so this replies with
// text shaped like what the feature under test expects, and settles the run.
//
// Shape-of-the-answer only: the point is to drive OUR streaming, transcript and
// capture code, not to model an agent.
const HANDOVER_REPLY = `# Handover: mock session

## 1. Summary
A mock handover, written by test/mock-opencode.js.

## 8. Remaining work
1. **Recommended next action** — nothing; this is a test fixture.
`;

const PLAIN_REPLY = "Acknowledged.";
const THINKING = "Let me check what was asked. It looks routine, so I will just answer it.";

// The work-profile classifier (stores/workprofile.js) prompts a model and reads
// JSON back out of the reply. Answering "Acknowledged." to it would exercise
// only the give-up path, so the loop recognises the prompt — by the preamble in
// lib/workcategories.js — and answers in the shape the real thing is asked for.
//
// Deliberately wrapped in a code fence: the prompt says not to, models do it
// anyway, and parseClassifierReply is built to cope. A mock that always replies
// perfectly would never have caught that.
const CLASSIFIER_PREAMBLE = "You are a work classifier.";
const CLASSIFIER_REPLY = '```json\n{"security": 70, "backend": 30}\n```';

// --- The agent loop ----------------------------------------------------------
//
// Modelled on a real turn, captured from `opencode2 serve` 0.0.0-next-202606270058
// by tapping GET /api/event (see docs/opencode-api.md § SSE event catalog):
//
//   session.next.prompt.admitted -> session.next.prompted
//     -> session.next.step.started
//        -> reasoning.started/.delta/.ended -> text.started/.delta/.ended
//     -> session.next.step.ended {finish: "stop", cost, tokens}
//
// Two things that the frontend has to get right are only visible against a loop
// that behaves like this one:
//
//  · There is no "run finished" event. `step.ended` is the last thing a turn
//    emits, and it is NOT the end of the loop when a prompt was steered in —
//    the loop promotes the steered input and runs another step. What ends the
//    run is the session leaving GET /api/session/active.
//  · `control.vocabulary = "classic"` switches to the `session.execution.*` /
//    `ordinal` spelling the other build in the wild emits, which the frontend
//    normalizes onto the same handlers.
const DEFAULT_CONTROL = {
  vocabulary: "next", // "next" | "classic"
  // Simulates a turn whose ending is never announced (a stream that dropped
  // mid-run, or a build with a lifecycle we don't know): the loop drains but
  // emits no step.ended, so only the run-state poll can settle it.
  dropTerminalEvents: false,
  stepMs: 30,
};

// Set through POST /api/mock/control, reset per page load.
const control = { ...DEFAULT_CONTROL };

// Sessions whose agent loop is running, and the inputs admitted into a loop that
// was already going (steered), keyed by session.
const running = new Set();
const steered = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Event names differ per build, and admission/promotion are named differently
// again in the classic spelling. The payload keys for a streaming part differ
// with them too (`ordinal` vs `textID`/`reasoningID`).
const CLASSIC_NAMES = {
  "prompt.admitted": "session.input.admitted",
  prompted: "session.input.promoted",
};

function ev(name) {
  if (control.vocabulary !== "classic") return `session.next.${name}`;
  return CLASSIC_NAMES[name] || `session.${name}`;
}

function partIDs(kind, id) {
  return control.vocabulary === "classic" ? { ordinal: 0 } : { [`${kind}ID`]: `${kind}-${id}` };
}

let nextTime = 100;

function replyFor(text) {
  if (/^Write a HANDOVER DOCUMENT/.test(text || "")) return HANDOVER_REPLY;
  if ((text || "").startsWith(CLASSIFIER_PREAMBLE)) return CLASSIFIER_REPLY;
  return PLAIN_REPLY;
}

// One step of the loop: think a little, answer, end the step.
async function runStep(sessionID, text) {
  const list = TRANSCRIPT[sessionID] || (TRANSCRIPT[sessionID] = []);
  const seq = nextEventSeq;
  const assistantMessageID = `msg_a_mock${seq}`;
  const reply = replyFor(text);

  // Recorded before the run settles: settling triggers a transcript refresh, and
  // a reply the refresh can't see would be wiped off screen the moment it landed.
  list.push({ id: `msg_u_mock${seq}`, type: "user", time: { created: nextTime++ }, text: text || "" });
  list.push({
    id: assistantMessageID,
    type: "assistant",
    time: { created: nextTime++ },
    content: [
      { type: "reasoning", text: THINKING },
      { type: "text", text: reply },
    ],
  });

  const base = { sessionID, assistantMessageID };
  emit(ev("step.started"), { ...base, agent: "build", model: { providerID: "acme", id: "sol-1" } });

  const reasoning = { ...base, ...partIDs("reasoning", 0) };
  emit(ev("reasoning.started"), reasoning);
  for (const word of THINKING.split(" ")) {
    await sleep(control.stepMs);
    emit(ev("reasoning.delta"), { ...reasoning, delta: `${word} ` });
  }
  emit(ev("reasoning.ended"), { ...reasoning, text: THINKING });

  const body = { ...base, ...partIDs("text", 0) };
  emit(ev("text.started"), body);
  await sleep(control.stepMs);
  emit(ev("text.delta"), { ...body, delta: reply });
  emit(ev("text.ended"), { ...body, text: reply });

  await sleep(control.stepMs);
  if (control.dropTerminalEvents) return;
  emit(ev("step.ended"), {
    ...base,
    finish: "stop",
    cost: 0.01,
    tokens: { input: 120, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  if (control.vocabulary === "classic") emit("session.execution.succeeded", { sessionID });
}

// The loop: the prompt that started it, then anything steered in while it ran.
async function runLoop(sessionID, text) {
  running.add(sessionID);
  try {
    await runStep(sessionID, text);
    while (steered.get(sessionID)?.length) {
      const next = steered.get(sessionID).shift();
      // Promotion is what the composer's steer pill waits for.
      emit(ev("prompted"), {
        sessionID,
        messageID: next.messageID,
        prompt: { text: next.text },
        delivery: "steer",
      });
      await runStep(sessionID, next.text);
    }
  } finally {
    running.delete(sessionID);
  }
}

// POST /api/session/{id}/prompt — admits one input. Into a loop that is already
// going it is a steer; otherwise it starts the loop. Either way the answer is a
// `SessionInput.Admitted` record, and the turn happens on the event stream.
function admitPrompt(sessionID, text, res) {
  const messageID = `msg_u_admitted${nextEventSeq}`;
  emit(ev("prompt.admitted"), {
    sessionID,
    messageID,
    prompt: { text: text || "" },
    delivery: "steer",
  });
  json(res, {
    data: {
      admittedSeq: nextEventSeq,
      id: messageID,
      sessionID,
      prompt: { text: text || "" },
      delivery: "steer",
      timeCreated: Date.now(),
    },
  });

  if (running.has(sessionID)) {
    if (!steered.has(sessionID)) steered.set(sessionID, []);
    steered.get(sessionID).push({ messageID, text });
    return;
  }
  runLoop(sessionID, text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/health") return json(res, { ok: true });
  if (url === "/api/model") return json(res, { data: MODELS });
  if (url === "/api/agent") return json(res, { data: AGENTS });
  if (url === "/api/command")
    return json(res, { data: [{ name: "compact", description: "compact the session" }] });
  if (url === "/api/skill")
    return json(res, { data: [{ id: "pdf", name: "pdf", description: "read pdfs" }] });
  if (url === "/api/session")
    return req.method === "POST"
      ? createSession(res)
      : json(res, {
          data: [
            ...SESSIONS,
            ...(seed.richHistory ? EXTRA_SESSIONS : []),
            ...(seed.creatureHistory ? CREATURE_SESSIONS : []),
          ],
        });
  // The run-state probe: every session whose agent loop is running right now.
  // "Sessions absent from the result are inactive" — this is what tells the
  // frontend a turn is over, since no event does. See stores/opencode/run.js.
  if (url === "/api/session/active") {
    return json(res, {
      data: Object.fromEntries([...running].map((id) => [id, { type: "running" }])),
    });
  }
  // Not part of the API either: push an arbitrary event onto the held-open
  // stream. The gating surfaces (permission.v2.asked, question.v2.asked) are
  // driven by the server rather than by anything a spec can click, so without
  // this they could only be tested by stubbing the network — which is the thing
  // this file exists to avoid. Body is the event itself: {type, data}.
  if (url === "/api/mock/emit" && req.method === "POST") {
    return readBody(req).then((body) => {
      if (body.type) emit(body.type, body.data || {});
      json(res, { data: { emitted: body.type || null } });
    });
  }
  // Replying to a permission ask. The reply is echoed back on the stream as
  // `permission.v2.replied`, which is how the real server closes the loop — the
  // frontend drops the queue entry on its own POST, but a second client watching
  // the same session learns about it this way.
  const permissionReply = url.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
  if (permissionReply && req.method === "POST") {
    return readBody(req).then((body) => {
      emit("permission.v2.replied", { requestID: permissionReply[2], reply: body.reply });
      json(res, { data: { id: permissionReply[2], reply: body.reply } });
    });
  }
  // Not part of the API: how a spec picks the event vocabulary or asks for a run
  // whose ending is never announced.
  if (url === "/api/mock/control" && req.method === "POST") {
    return readBody(req).then((body) => {
      // Seed keys are routed to `seed`, which survives a stream reconnect;
      // everything else is stream behaviour and lives in `control`.
      const { richHistory, creatureHistory, ...rest } = body;
      if (richHistory !== undefined) seed.richHistory = richHistory;
      if (creatureHistory !== undefined) seed.creatureHistory = creatureHistory;
      Object.assign(control, rest);
      json(res, { data: { ...control, ...seed } });
    });
  }
  const messages = url.match(/^\/api\/session\/([^/]+)\/message$/);
  if (messages) return json(res, { data: TRANSCRIPT[messages[1]] || [] });
  const prompt = url.match(/^\/api\/session\/([^/]+)\/prompt$/);
  if (prompt && req.method === "POST") {
    // Flat first, wrapped second — transport.js sends whichever shape it has
    // learned works, and both are legitimate (see its header comment).
    return readBody(req).then((body) =>
      admitPrompt(prompt[1], body.text ?? (body.prompt && body.prompt.text), res)
    );
  }
  if (/^\/api\/session\/[^/]+\/context$/.test(url)) return json(res, { data: {} });
  if (url === "/api/question/request") return json(res, { data: [] });
  if (url === "/api/integration") return json(res, { data: [] });

  if (url === "/api/event") {
    resetCreatedSessions();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ id: "e1", type: "server.connected", data: {} })}\n\n`);
    eventStream = res;
    req.on("close", () => {
      if (eventStream === res) eventStream = null;
    });
    return; // held open for the life of the run
  }

  // Unknown route: answer with an empty list envelope rather than a 404, so a
  // store reaching for something new fails visibly in the UI instead of
  // throwing in a fetch nobody is watching.
  json(res, { data: [] });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock opencode2 on :${PORT}`));

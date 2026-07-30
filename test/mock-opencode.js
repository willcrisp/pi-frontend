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
const SESSIONS = [
  {
    id: "ses_mock1",
    title: "Mock session",
    time: { created: 1, updated: 2 },
    location: { directory: DIRECTORY },
  },
  {
    id: "ses_mock2",
    title: "Second session",
    time: { created: 1, updated: 1 },
    location: { directory: DIRECTORY },
  },
];

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
  return /^Write a HANDOVER DOCUMENT/.test(text || "") ? HANDOVER_REPLY : PLAIN_REPLY;
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
    return req.method === "POST" ? createSession(res) : json(res, { data: SESSIONS });
  // The run-state probe: every session whose agent loop is running right now.
  // "Sessions absent from the result are inactive" — this is what tells the
  // frontend a turn is over, since no event does. See stores/opencode/run.js.
  if (url === "/api/session/active") {
    return json(res, {
      data: Object.fromEntries([...running].map((id) => [id, { type: "running" }])),
    });
  }
  // Not part of the API: how a spec picks the event vocabulary or asks for a run
  // whose ending is never announced.
  if (url === "/api/mock/control" && req.method === "POST") {
    return readBody(req).then((body) => {
      Object.assign(control, body);
      json(res, { data: control });
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

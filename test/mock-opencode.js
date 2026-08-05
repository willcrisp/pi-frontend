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

// A 120x80 test-pattern PNG, standing in for a screenshot the agent read off
// disk. A tool
// call's image result rides in `content` as a text sentinel plus a file block
// carrying the data URI — the exact shape the real `read` tool emits for an
// image (see docs/opencode-api.md § SSE event catalog).
const PNG_BASE64 =
  "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";
const IMAGE_READ_PATH = `${DIRECTORY}/docs/screenshot.png`;
const IMAGE_READ_CONTENT = [
  { type: "text", text: "Image read successfully" },
  {
    type: "file",
    uri: `data:image/png;base64,${PNG_BASE64}`,
    mime: "image/png",
    name: IMAGE_READ_PATH,
  },
];

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
// copy button), an edit-shaped tool call (for the diff view), an image-read
// tool call (for inline image rendering), and user prompts either side of it
// (for the prompt rail and its fork button). The second session stays empty,
// so the draft test switches into a clean chat.
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
        {
          type: "tool",
          name: "serena_find_referencing_symbols",
          id: "call_serena_1",
          state: {
            status: "completed",
            input: { name_path: "MyClass", relative_path: "src/index.ts" },
            content: [{ type: "text", text: "Found 3 references." }],
          },
        },
        {
          type: "tool",
          name: "read",
          id: "call_read_img_1",
          state: {
            status: "completed",
            input: { path: IMAGE_READ_PATH },
            content: IMAGE_READ_CONTENT,
          },
        },
        {
          type: "tool",
          name: "websearch",
          id: "call_search_1",
          state: {
            status: "completed",
            input: { query: "OpenCode reasoning levels" },
            content: [{
              type: "json",
              value: [{
                title: "OpenCode documentation",
                url: "https://opencode.ai/docs/",
                snippet: "Configure models, agents, and session behavior.",
              }],
            }],
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
  pendingQuestions.clear();
  // The waiters themselves are left pending on purpose: resolving them would
  // let a previous test's blocked loop finish and emit its events into the NEW
  // page's stream. A leaked promise is silent; a leaked event is not.
  questionWaiters.clear();
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
  // Simulates a run that parks mid-step on a question whose question.v2.asked
  // event never arrives: the loop holds the session active until the ask is
  // answered over REST, so only the pending-request poll can unblock it.
  holdForQuestion: false,
  // Simulates a run that parks mid-step on a question whose events the stream
  // DOES announce (tool part + question.v2.asked): the inline Q&A card
  // (QuestionPart.vue) drives the answer, and the tool.success with
  // metadata.answers lets the card survive a transcript refresh.
  askQuestion: false,
  // Simulates a turn that fails (e.g. model rate-limit): the step ends with
  // finish:"error" and the assistant message carries an error string, so the
  // message-level error rendering in MessageView gets exercised.
  failTurn: false,
  // Emits the web-search tool lifecycle, including a progress update with a
  // source page. This lets transcript tests exercise the live card without a
  // real external search provider.
  webSearch: false,
  webSearchDelay: 0,
  webSearchAborted: false,
  // Emits a `read` of an image file: the tool lifecycle whose success content
  // carries the image as a file block, so the live inline-image path (not just
  // the seeded history one) gets exercised.
  readImage: false,
  stepMs: 30,
};

// Set through POST /api/mock/control, reset per page load.
const control = { ...DEFAULT_CONTROL };

// Sessions whose agent loop is running, and the inputs admitted into a loop that
// was already going (steered), keyed by session.
const running = new Set();
const steered = new Map();

// Outstanding asks: what GET /api/question/request serves, and the resolve
// functions the blocked loops are parked on (the reply route settles them).
const pendingQuestions = new Map();
const questionWaiters = new Map();

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

  // Park the loop on a question the stream never announces. The session stays
  // on /api/session/active the whole time — exactly what a real server looks
  // like while it waits on an answer — so this is the stalled-red-square case
  // the pending-request poll exists to recover (stores/opencode/run.js).
  const QUESTIONS = [
    {
      question: "Which way should I go?",
      header: "Direction",
      options: [
        { label: "Left", description: "take the left path" },
        { label: "Right", description: "take the right path" },
      ],
      multiple: false,
    },
  ];

  const FORM_META = { kind: "question", tool: { messageID: assistantMessageID } };

  if (control.holdForQuestion) {
    // Register a form without emitting its event — simulates a dropped
    // `form.created` so the poll (GET /api/form/request) must recover it.
    const id = `frm_mock${seq}`;
    const meta = control.askQuestion
      ? { ...FORM_META, tool: { ...FORM_META.tool, callID: `call_q_${seq}` } }
      : FORM_META;
    pendingQuestions.set(id, {
      id,
      sessionID,
      title: QUESTIONS[0]?.header || "Question",
      metadata: meta,
      fields: QUESTIONS.map((q, i) => ({
        key: `q${i}`,
        title: q.header,
        description: q.question,
        type: q.multiple ? "multiselect" : "string",
        options: (q.options || []).map((o) => ({
          value: o.label,
          label: o.label,
          description: o.description,
        })),
        custom: q.custom !== false,
      })),
    });
    await new Promise((resolve) => questionWaiters.set(id, resolve));
  }

  // askQuestion: the full live path. Tool-call events stream, form.created
  // fires, and the stored transcript includes the settled tool call so the
  // inline card (QuestionPart.vue) survives a transcript refresh.
  if (control.askQuestion) {
    const callID = `call_q_${seq}`;
    const formID = `frm_mock${seq}`;
    const stored = list[list.length - 1];

    emit(ev("tool.input.started"), { ...base, callID, name: "question" });
    emit(ev("tool.input.ended"), {
      ...base,
      callID,
      text: JSON.stringify({ questions: QUESTIONS }),
    });
    emit(ev("tool.called"), { ...base, callID, tool: "question" });

    const form = {
      id: formID,
      sessionID,
      title: QUESTIONS[0]?.header || "Question",
      metadata: { ...FORM_META, tool: { ...FORM_META.tool, callID } },
      fields: QUESTIONS.map((q, i) => ({
        key: `q${i}`,
        title: q.header,
        description: q.question,
        type: q.multiple ? "multiselect" : "string",
        options: (q.options || []).map((o) => ({
          value: o.label,
          label: o.label,
          description: o.description,
        })),
        custom: q.custom !== false,
      })),
    };
    emit("form.created", { form });

    const answer = await new Promise((resolve) =>
      questionWaiters.set(formID, resolve)
    );

    const answers = [];
    if (answer) {
      for (let i = 0; i < QUESTIONS.length; i++) {
        const key = `q${i}`;
        const val = answer[key];
        if (val === undefined) { answers.push([]); continue; }
        answers.push(Array.isArray(val) ? val : [val]);
      }
    } else {
      for (let i = 0; i < QUESTIONS.length; i++) answers.push([]);
    }

    const output = `User has answered your questions: "Which way should I go?"="${answers[0]?.join(", ") || "Unanswered"}". You can now continue with the user's answers in mind.`;
    emit("form.replied", { id: formID, sessionID, answer });
    emit(ev("tool.success"), {
      ...base,
      callID,
      content: [{ type: "text", text: output }],
      metadata: { metadata: { answers } },
    });

    stored.content.push({
      type: "tool",
      name: "question",
      id: callID,
      state: {
        status: "completed",
        input: { questions: QUESTIONS },
        content: [{ type: "text", text: output }],
        metadata: { answers },
      },
    });
  }

  if (control.failTurn) {
    list[list.length - 1].error = "Rate limit exceeded — try again in 30 seconds";
    list[list.length - 1].content = [];
    await sleep(control.stepMs);
    emit(ev("step.ended"), {
      ...base,
      finish: "error",
      cost: 0,
      tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    return;
  }

  if (control.webSearch) {
    const callID = `call_search_${seq}`;
    const query = "Serena AI coding agent";
    const source = {
      title: "Serena - The coding agent toolkit",
      url: "https://oraios.github.io/serena/",
      snippet: "Serena provides semantic code retrieval and editing tools.",
    };
    emit(ev("tool.input.started"), { ...base, callID, name: "websearch" });
    emit(ev("tool.input.ended"), { ...base, callID, text: JSON.stringify({ query }) });
    emit(ev("tool.called"), { ...base, callID, tool: "websearch" });
    emit(ev("tool.progress"), {
      ...base,
      callID,
      progress: { message: "Checking official documentation" },
      content: [{ type: "json", value: [source] }],
    });
    await sleep(control.webSearchDelay);
    const content = control.webSearchAborted
      ? [{ type: "text", text: JSON.stringify({ type: "aborted", message: "Step interrupted" }) }]
      : [{ type: "json", value: [source] }];
    emit(ev("tool.success"), { ...base, callID, content });
    list[list.length - 1].content.push({
      type: "tool",
      name: "websearch",
      id: callID,
      state: { status: "completed", input: { query }, content },
    });
  }

  if (control.readImage) {
    const callID = `call_read_img_${seq}`;
    emit(ev("tool.input.started"), { ...base, callID, name: "read" });
    emit(ev("tool.input.ended"), {
      ...base,
      callID,
      text: JSON.stringify({ path: IMAGE_READ_PATH }),
    });
    emit(ev("tool.called"), { ...base, callID, tool: "read" });
    await sleep(control.stepMs);
    emit(ev("tool.success"), { ...base, callID, content: IMAGE_READ_CONTENT });
    list[list.length - 1].content.push({
      type: "tool",
      name: "read",
      id: callID,
      state: { status: "completed", input: { path: IMAGE_READ_PATH }, content: IMAGE_READ_CONTENT },
    });
  }

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
      : json(res, { data: seed.richHistory ? [...SESSIONS, ...EXTRA_SESSIONS] : SESSIONS });
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
      const { richHistory, ...rest } = body;
      if (richHistory !== undefined) seed.richHistory = richHistory;
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
  if (url === "/api/question/request") return json(res, { data: [...pendingQuestions.values()] });
  // Pending forms that the poll recovers: GET /api/form/request
  if (url === "/api/form/request") return json(res, { data: [...pendingQuestions.values()] });
  // Answering an ask unblocks the loop parked on it. 204, like the real route.
  // Question endpoints (older builds) and form endpoints (current build).
  const qreply = url.match(/^\/api\/session\/[^/]+\/question\/([^/]+)\/reply$/);
  if (qreply && req.method === "POST") {
    return readBody(req).then((body) => {
      pendingQuestions.delete(qreply[1]);
      const unblock = questionWaiters.get(qreply[1]);
      questionWaiters.delete(qreply[1]);
      if (unblock) unblock((body && body.answers) || []);
      res.writeHead(204);
      res.end();
    });
  }
  const freply = url.match(/^\/api\/session\/[^/]+\/form\/([^/]+)\/reply$/);
  if (freply && req.method === "POST") {
    return readBody(req).then((body) => {
      pendingQuestions.delete(freply[1]);
      const unblock = questionWaiters.get(freply[1]);
      questionWaiters.delete(freply[1]);
      if (unblock) unblock((body && body.answer) || {});
      res.writeHead(204);
      res.end();
    });
  }
  const qreject = url.match(/^\/api\/session\/[^/]+\/question\/([^/]+)\/reject$/);
  if (qreject && req.method === "POST") {
    pendingQuestions.delete(qreject[1]);
    const unblock = questionWaiters.get(qreject[1]);
    questionWaiters.delete(qreject[1]);
    if (unblock) unblock(null);
    res.writeHead(204);
    return res.end();
  }
  const fcancel = url.match(/^\/api\/session\/[^/]+\/form\/([^/]+)\/cancel$/);
  if (fcancel && req.method === "POST") {
    pendingQuestions.delete(fcancel[1]);
    const unblock = questionWaiters.get(fcancel[1]);
    questionWaiters.delete(fcancel[1]);
    if (unblock) unblock(null);
    res.writeHead(204);
    return res.end();
  }
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

// A stand-in for `opencode2 serve`, used by the Playwright tests.
//
// It implements just enough of the V2 HttpApi to boot the frontend: health, the
// four catalogs, a session list, an empty transcript, and an SSE stream that
// stays open. It is NOT a fidelity model of the real server — the point is to
// exercise OUR code (stores, composables, components) without needing a live
// agent, so responses are the minimum shape docs/opencode-api.md says each
// route returns.
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
let nextSessionSeq = 3;

// Sessions a test created are dropped when the next page loads (a client
// opening the event stream is the signal). One worker runs the suite serially,
// so this is the cheap equivalent of a per-test server: the fork test creates a
// session and asserts against it, and the next test still sees the two seeded
// ones — which several of them count.
function resetCreatedSessions() {
  SESSIONS.length = BASE_SESSION_COUNT;
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
  const messages = url.match(/^\/api\/session\/([^/]+)\/message$/);
  if (messages) return json(res, { data: TRANSCRIPT[messages[1]] || [] });
  if (/^\/api\/session\/[^/]+\/context$/.test(url)) return json(res, { data: {} });
  if (url === "/api/question/request") return json(res, { data: [] });
  if (url === "/api/integration") return json(res, { data: [] });

  if (url === "/api/event") {
    resetCreatedSessions();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ id: "e1", type: "server.connected", data: {} })}\n\n`);
    return; // held open for the life of the run
  }

  // Unknown route: answer with an empty list envelope rather than a 404, so a
  // store reaching for something new fails visibly in the UI instead of
  // throwing in a fetch nobody is watching.
  json(res, { data: [] });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock opencode2 on :${PORT}`));

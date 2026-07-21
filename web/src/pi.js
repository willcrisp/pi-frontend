// WebSocket client for the pi RPC protocol.
// The server bridges one `pi --mode rpc` process per *chat* (project ×
// conversation) at `/ws/{projectId}?chat={chatId}`. Every chat the UI has
// visited keeps its own live connection and reactive state object here, so
// an agent keeps running — and keeps streaming into its own chat's state —
// while a different chat (or project) is in view. Switching chats is just
// re-pointing the exported `store` proxy at another chat's state; nothing
// is torn down and no `switch_session` is ever sent to a busy process.
// The sidebar reads per-chat working/unread status from the same registry
// via chatIndicator()/projectIndicator().
import { reactive, shallowRef } from "vue";

function initialStore() {
  return {
    connected: false,
    streaming: false,
    model: null,
    thinkingLevel: null,
    availableModels: [],
    sessionName: null,
    messages: [],
    // toolCallId -> { name, running, text, isError, details, startedAt, endedAt }
    toolResults: {},
    // { sessionFile, sessionId, tokens: {input,output,cacheRead,cacheWrite,total}, cost, contextUsage } or null
    sessionStats: null,
    // Extension/prompt-template/skill commands invocable via "/name args" in a prompt,
    // from get_commands: [{ name, description, source, sourceInfo }]
    commands: [],
    // User messages on the active branch that can be forked from, from
    // get_fork_messages: [{ entryId, text }] in send order. Paired positionally
    // with the user messages in `messages` by MessageRail.vue.
    forkMessages: [],
    // Text to load into the composer (set when a fork hands back the prompt it
    // branched from, mirroring what pi's TUI does on /fork). Composer.vue
    // watches this and clears it once consumed.
    composerDraft: "",
    // Pending steering/follow-up messages, mirrored from pi's queue_update
    // events. Shown as chips above the composer until pi delivers them.
    queue: { steering: [], followUp: [] },
    // Blocking extension UI dialogs (select/confirm/input/editor) from the
    // extension_ui_request sub-protocol, oldest first. The agent is blocked
    // until each is answered via respondExtensionUI(). [{ id, method, ... }]
    uiRequests: [],
    // Fire-and-forget extension notifications, shown as transient toasts.
    // [{ id, message, notifyType }]
    uiNotices: [],
    // { message, exitCode } from a synthetic pi_web_process_error frame (see
    // spawn_process in server/src/main.rs) — the pi/ssh child failed to start
    // or crashed, with its stderr tail as the message. Cleared once the
    // process is confirmed alive again (get_state succeeds).
    processError: null,
    // Set when this chat's agent settled while another chat was in view;
    // cleared when the chat is activated. Drives the sidebar's unread dot.
    unread: false,
  };
}

// --- Connection registry --------------------------------------------------
// One conn per chat: { projectId, key, chatId, intendedSession, ws, state,
// currentIndex, closed, lastActiveAt }. `key` is the UI-level identity —
// "s:<sessionPath>" once the chat's session file is known, "new:<uuid>" /
// "p:<projectId>" before that. `chatId` is the server-side pool token baked
// into the WS URL; it never changes for the life of the process, which is
// why the sessionPath -> chatId mapping is remembered (localStorage) so a
// reload re-attaches to the same still-running process instead of spawning
// a second one against the same session file.
export const connIndex = reactive({}); // key -> conn

const activeRef = shallowRef(null); // conn whose state the `store` proxy shows
const detachedState = reactive(initialStore()); // shown when no project is selected
let currentProjectId = null;

// Cap on simultaneously-open chat connections; beyond it, the least
// recently viewed idle chat (not streaming, nothing unread) is dropped.
// Its pi process lives on server-side until the idle sweeper reaps it, and
// re-opening the chat reconnects to it.
const MAX_CONNS = 12;

function activeState() {
  const conn = activeRef.value;
  return conn ? conn.state : detachedState;
}

// The active chat's state, behind a stable identity so components can keep
// importing a single `store` object. Reads/writes fall through to the
// active conn's reactive state; reading also touches `activeRef` so every
// consumer re-renders when the active chat changes.
export const store = new Proxy(
  {},
  {
    get: (_, prop) => activeState()[prop],
    set: (_, prop, value) => {
      activeState()[prop] = value;
      return true;
    },
    has: (_, prop) => prop in activeState(),
    ownKeys: () => Reflect.ownKeys(activeState()),
    getOwnPropertyDescriptor: (_, prop) => Object.getOwnPropertyDescriptor(activeState(), prop),
  }
);

// --- Persistence (survive reloads) ---------------------------------------
// lastChat:<projectId> -> which chat to land on when selecting the project.
// sessionChatIds -> sessionPath -> server chatId, so a reload (or a later
// sidebar click) re-attaches to the process already running that session.
const LAST_CHAT_PREFIX = "pi-web:lastChat:";
const SESSION_CHAT_IDS_KEY = "pi-web:sessionChatIds";

function loadSessionChatIds() {
  try {
    const v = JSON.parse(localStorage.getItem(SESSION_CHAT_IDS_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const sessionChatIds = loadSessionChatIds();

function rememberSessionChatId(sessionPath, chatId) {
  if (sessionChatIds[sessionPath] === chatId) return;
  // Re-insert so iteration order doubles as least-recently-used order.
  delete sessionChatIds[sessionPath];
  sessionChatIds[sessionPath] = chatId;
  const keys = Object.keys(sessionChatIds);
  for (let i = 0; i < keys.length - 200; i++) delete sessionChatIds[keys[i]];
  try {
    localStorage.setItem(SESSION_CHAT_IDS_KEY, JSON.stringify(sessionChatIds));
  } catch {}
}

function rememberLastChat(conn) {
  try {
    localStorage.setItem(
      LAST_CHAT_PREFIX + conn.projectId,
      JSON.stringify({ key: conn.key, chatId: conn.chatId, session: conn.intendedSession })
    );
  } catch {}
}

function loadLastChat(projectId) {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_CHAT_PREFIX + projectId) || "null");
    return v && v.key && v.chatId ? v : null;
  } catch {
    return null;
  }
}

// Detects a sub-agent dispatch tool result (the shape produced by pi-mono's
// example `subagent` extension: `details = { mode, results: [...] }`, one
// entry per dispatched task) shared by SubagentView.vue, MessageView.vue and
// UsagePopover.vue so they all agree on what counts as a sub-agent call.
export function subagentDetails(r) {
  return Array.isArray(r?.details?.results) ? r.details : null;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Subset of pi's BUILTIN_SLASH_COMMANDS (core/slash-commands.js) that both (a) have
// no equivalent already in this UI, and (b) map onto an RPC command this frontend
// can actually execute. Selecting one runs it immediately (see runBuiltinCommand in
// App.vue) rather than inserting text — unlike everything else in the dropdown,
// these never get sent to pi as a prompt.
//
// Left out as redundant with existing UI: model (model <select>), resume (sidebar
// chat history), session (usage popover). Left out as
// unsupported outside a real terminal/TUI: settings, scoped-models, import, share,
// changelog, hotkeys, trust, login, logout, quit, reload. Left out pending a
// message/branch picker UI: fork, clone, tree.
export const BUILTIN_SLASH_COMMANDS = [
  { name: "new", description: "Start a new chat in this project" },
  { name: "name", description: "Set session display name" },
  { name: "export", description: "Export session as HTML" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "compact", description: "Manually compact the session context" },
];

// Called when the sidebar's chat-history list may have gone stale — after a
// chat is created/switched, and after each turn settles (a new chat is only
// persisted/titleable once its first turn runs). Wired up once from App.vue.
let onSessionSwitched = null;

export function setOnSessionSwitched(fn) {
  onSessionSwitched = fn;
}

// --- Conn lifecycle -------------------------------------------------------

function createConn(projectId, key, chatId, intendedSession, { freshChat = false } = {}) {
  evictIdleConns();
  const conn = {
    projectId,
    key,
    chatId,
    intendedSession,
    // Created as a brand-new empty chat (vs opened onto a past session);
    // lets newSession() reuse an untouched new chat instead of spawning
    // another process. Cleared implicitly once messages exist.
    freshChat,
    state: reactive(initialStore()),
    ws: null,
    closed: false,
    currentIndex: -1, // index into state.messages of the streaming assistant message
    statsPollTimer: null,
    lastActiveAt: Date.now(),
  };
  connIndex[key] = conn;
  connectConn(conn);
  return conn;
}

function evictIdleConns() {
  const conns = Object.values(connIndex);
  if (conns.length < MAX_CONNS) return;
  const idle = conns
    .filter(
      (c) =>
        c !== activeRef.value && !c.state.streaming && !c.state.unread && !c.state.uiRequests.length
    )
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const c of idle.slice(0, conns.length - MAX_CONNS + 1)) closeConn(c);
}

function closeConn(conn) {
  conn.closed = true;
  stopStatsPolling(conn);
  if (conn.ws) {
    conn.ws.onclose = null; // no auto-reconnect for an intentional close
    conn.ws.close();
    conn.ws = null;
  }
  delete connIndex[conn.key];
}

// Tear down every connection for a removed project (their processes are
// killed server-side by DELETE /api/projects/{id}).
export function dropProject(projectId) {
  for (const key of Object.keys(connIndex)) {
    if (connIndex[key].projectId === projectId) closeConn(connIndex[key]);
  }
  if (activeRef.value?.projectId === projectId) activeRef.value = null;
  if (currentProjectId === projectId) currentProjectId = null;
}

// Session stats are not pushed while pi is generating a response. Poll only
// during a run so the header and usage popover can show progress without
// adding a background request for idle chats.
function startStatsPolling(conn) {
  if (conn.statsPollTimer) return;
  sendTo(conn, { type: "get_session_stats" });
  conn.statsPollTimer = setInterval(() => {
    if (conn.state.streaming) sendTo(conn, { type: "get_session_stats" });
  }, 10_000);
}

function stopStatsPolling(conn) {
  if (!conn.statsPollTimer) return;
  clearInterval(conn.statsPollTimer);
  conn.statsPollTimer = null;
}

function connectConn(conn) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${location.host}/ws/${conn.projectId}?chat=${encodeURIComponent(conn.chatId)}`
  );
  conn.ws = ws;
  ws.onopen = () => {
    if (conn.ws !== ws || conn.closed) return;
    conn.state.connected = true;
    syncOnOpen(conn);
  };
  ws.onclose = () => {
    if (conn.ws !== ws) return;
    conn.state.connected = false;
    // Background conns reconnect too — their dot stays live and a server
    // restart re-establishes every chat (each conditional-switching back to
    // its session via syncOnOpen).
    setTimeout(() => {
      if (conn.ws === ws && !conn.closed) connectConn(conn);
    }, 1500);
  };
  ws.onmessage = (e) => {
    if (conn.ws !== ws) return;
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(conn, ev);
  };
}

// On (re)connect: if this chat targets a specific past session but the
// process on the other end (freshly spawned on a new empty session, or a
// respawn after a server restart/reap) isn't on it, switch to it before
// fetching messages. Never switches while the process is streaming — that
// would abort the run, which is exactly what per-chat processes exist to
// prevent; in that case the process's current session is shown as-is.
async function syncOnOpen(conn) {
  sendTo(conn, { type: "get_available_models" });
  sendTo(conn, { type: "get_commands" });
  if (conn.intendedSession) {
    try {
      const st = await requestOn(conn, { type: "get_state" });
      const stats = await requestOn(conn, { type: "get_session_stats" });
      if (stats?.sessionFile && stats.sessionFile !== conn.intendedSession && !st?.isStreaming) {
        await requestOn(conn, { type: "switch_session", sessionPath: conn.intendedSession });
      }
    } catch {
      // Keep whatever session the process is on; the fetches below still run.
    }
  }
  sendTo(conn, { type: "get_state" });
  sendTo(conn, { type: "get_messages" });
  sendTo(conn, { type: "get_session_stats" });
  sendTo(conn, { type: "get_fork_messages" });
}

function activate(conn) {
  conn.lastActiveAt = Date.now();
  conn.state.unread = false;
  activeRef.value = conn;
  rememberLastChat(conn);
}

// Re-key a conn to its now-known session file, so sidebar clicks on that
// session find this live conn (and process) instead of spawning another
// process against the same session file.
function rekeyConn(conn, sessionFile) {
  const newKey = `s:${sessionFile}`;
  if (conn.key === newKey) return;
  const existing = connIndex[newKey];
  if (existing && existing !== conn) {
    // Duplicate conn for the same session (e.g. opened from the sidebar
    // while a stale mapping pointed elsewhere) — keep this one.
    const wasActive = existing === activeRef.value;
    closeConn(existing);
    if (wasActive) activeRef.value = conn;
  }
  delete connIndex[conn.key];
  conn.key = newKey;
  conn.intendedSession = sessionFile;
  connIndex[newKey] = conn;
  rememberSessionChatId(sessionFile, conn.chatId);
  if (conn === activeRef.value) rememberLastChat(conn);
}

// --- Public chat navigation ----------------------------------------------

export function connectToProject(projectId) {
  currentProjectId = projectId;
  if (!projectId) {
    activeRef.value = null;
    return;
  }
  const last = loadLastChat(projectId);
  let conn = last ? connIndex[last.key] : null;
  if (!conn && last) conn = createConn(projectId, last.key, last.chatId, last.session || null);
  if (!conn)
    conn =
      connIndex[`p:${projectId}`] ||
      createConn(projectId, `p:${projectId}`, "default", null, { freshChat: true });
  activate(conn);
}

// Tear down the active view with no replacement (e.g. the current project
// was removed).
export function resetChat() {
  connectToProject(null);
}

// "+ new chat": a brand-new chat = a brand-new conn (and pi process), so
// whatever the current chat's agent is doing keeps running untouched. If
// we're already sitting on an unused new chat, reuse it instead of
// spawning another process.
export function newSession() {
  if (!currentProjectId) return;
  const a = activeRef.value;
  if (
    a &&
    a.projectId === currentProjectId &&
    a.freshChat &&
    !a.state.streaming &&
    a.state.messages.length === 0
  ) {
    return;
  }
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activate(createConn(currentProjectId, `new:${id}`, id, null, { freshChat: true }));
  onSessionSwitched?.();
}

// Open a past chat from the sidebar. If it's already live (its agent may
// well be mid-run), just re-point the view at it; otherwise open a
// connection — preferring the chatId of the process already running this
// session, if one is remembered — and let syncOnOpen land it on the session.
export function switchSession(sessionPath) {
  if (!currentProjectId) return;
  const key = `s:${sessionPath}`;
  let conn = connIndex[key];
  if (!conn) {
    const chatId = sessionChatIds[sessionPath] || sessionPath;
    conn = createConn(currentProjectId, key, chatId, sessionPath);
  }
  activate(conn);
}

// --- Sidebar status indicators -------------------------------------------
// "working": the chat's agent is running. "attention": it finished (or is
// blocked on an extension dialog) while the user was looking elsewhere.

export function chatIndicator(sessionPath) {
  const conn = connIndex[`s:${sessionPath}`];
  if (!conn) return null;
  const attention =
    conn !== activeRef.value && (conn.state.unread || conn.state.uiRequests.length > 0);
  if (attention) return "attention";
  return conn.state.streaming ? "working" : null;
}

export function projectIndicator(projectId) {
  let working = false;
  for (const key in connIndex) {
    const conn = connIndex[key];
    if (conn.projectId !== projectId) continue;
    if (conn !== activeRef.value && (conn.state.unread || conn.state.uiRequests.length > 0)) {
      return "attention";
    }
    if (conn.state.streaming) working = true;
  }
  return working ? "working" : null;
}

// --- RPC plumbing ---------------------------------------------------------

function sendTo(conn, cmd) {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(cmd));
  }
}

// Sends on the active chat's connection.
export function send(cmd) {
  const conn = activeRef.value;
  if (conn) sendTo(conn, cmd);
}

// Commands sent via request() get their response's `data` (or a thrown error)
// delivered back through this promise instead of the generic handleResponse
// branching below, keyed by the id pi's RPC protocol echoes back on the
// response. The random prefix keeps ids from colliding across browser tabs
// sharing one process's broadcast stream.
let reqId = 0;
const reqPrefix = Math.random().toString(36).slice(2, 8);
const pending = new Map();

function requestOn(conn, cmd) {
  const id = `req-${reqPrefix}-${++reqId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendTo(conn, { ...cmd, id });
  });
}

function request(cmd) {
  const conn = activeRef.value;
  if (!conn) return Promise.reject(new Error("no active chat"));
  return requestOn(conn, cmd);
}

export async function setSessionName(name) {
  await request({ type: "set_session_name", name });
  store.sessionName = name;
}

export function exportSession() {
  return request({ type: "export_html" });
}

export async function compactSession() {
  await request({ type: "compact" });
  send({ type: "get_session_stats" });
}

export async function copyLastAssistantText() {
  const { text } = await request({ type: "get_last_assistant_text" });
  if (text) await navigator.clipboard.writeText(text);
  return text;
}

// Branch the session at a previous user message (pi's `fork` RPC command / the
// TUI's /fork). pi rewinds the active branch to just before that message and
// hands back its text, which we load into the composer so it can be edited and
// re-sent down the new branch. Returns null if an extension cancelled the fork.
export async function forkFrom(entryId) {
  const data = await request({ type: "fork", entryId });
  if (data?.cancelled) return null;
  store.messages = [];
  store.toolResults = {};
  send({ type: "get_state" });
  send({ type: "get_messages" });
  send({ type: "get_session_stats" });
  send({ type: "get_fork_messages" });
  onSessionSwitched?.();
  store.composerDraft = data?.text || "";
  return data?.text ?? "";
}

// images: [{ mimeType, data }] with `data` as base64 (no data: prefix).
// streamingBehavior: "steer" | "followUp" — required by pi when the agent is
// already streaming (a bare prompt is rejected mid-stream), except for
// extension commands which execute immediately. Queued sends aren't pushed to
// store.messages optimistically: they aren't part of the conversation until pi
// delivers them, which we learn about via queue_update (and refresh from).
export function sendPrompt(text, images = [], streamingBehavior = null) {
  const imageBlocks = images.map((img) => ({
    type: "image",
    data: img.data,
    mimeType: img.mimeType,
  }));
  const cmd = { type: "prompt", message: text };
  if (imageBlocks.length) cmd.images = imageBlocks;
  if (streamingBehavior) {
    cmd.streamingBehavior = streamingBehavior;
  } else {
    const content = text ? [{ type: "text", text }, ...imageBlocks] : imageBlocks;
    store.messages.push({ role: "user", content });
  }
  send(cmd);
}

// Answer a blocking extension UI dialog (select/confirm/input/editor).
// payload is { value }, { confirmed }, or { cancelled: true } per the request's
// method — see "Extension UI Responses" in pi's docs/rpc.md.
export function respondExtensionUI(id, payload) {
  send({ type: "extension_ui_response", id, ...payload });
  store.uiRequests = store.uiRequests.filter((r) => r.id !== id);
}

export function dismissUiNotice(id) {
  store.uiNotices = store.uiNotices.filter((n) => n.id !== id);
}

export function abort() {
  send({ type: "abort" });
}

export function setModel(model) {
  send({ type: "set_model", provider: model.provider, modelId: model.id });
}

export function setThinkingLevel(level) {
  send({ type: "set_thinking_level", level });
}

// --- Event handling -------------------------------------------------------
// Every conn's events flow through here, active or not — a background chat
// keeps accumulating its own messages/tool results, so switching to it shows
// live state instantly with no refetch.

function handle(conn, ev) {
  const s = conn.state;
  switch (ev.type) {
    case "response":
      handleResponse(conn, ev);
      break;

    case "agent_start":
      s.streaming = true;
      startStatsPolling(conn);
      break;
    case "agent_settled":
      s.streaming = false;
      stopStatsPolling(conn);
      conn.currentIndex = -1;
      sendTo(conn, { type: "get_session_stats" });
      // The turn that just settled added a user message to the branch, so the
      // set of fork points changed.
      sendTo(conn, { type: "get_fork_messages" });
      // Queued steer/follow_up messages delivered during the run aren't pushed
      // to messages when sent (see sendPrompt); pick them up now that
      // replacing the transcript wholesale is safe.
      sendTo(conn, { type: "get_messages" });
      // Finished while another chat was in view -> unread dot until visited.
      if (conn !== activeRef.value) s.unread = true;
      // A freshly-started chat's session file isn't written (and has no user
      // message to title it) until its first turn runs, so it's absent from
      // the sidebar list fetched at new_session/select time. Re-list now that
      // the turn has settled so the active chat shows up — and keeps its
      // mtime/title current — without waiting for a project re-select.
      onSessionSwitched?.();
      break;

    case "message_start":
      if (ev.message.role === "assistant") {
        conn.currentIndex = s.messages.push(ev.message) - 1;
      }
      break;
    case "message_update":
      if (conn.currentIndex >= 0) {
        s.messages[conn.currentIndex] = ev.message;
      }
      break;
    case "message_end":
      if (conn.currentIndex >= 0 && ev.message.role === "assistant") {
        s.messages[conn.currentIndex] = ev.message;
        conn.currentIndex = -1;
      }
      break;

    case "tool_execution_start":
      s.toolResults[ev.toolCallId] = {
        name: ev.toolName,
        running: true,
        text: "",
        isError: false,
        startedAt: Date.now(),
      };
      break;
    case "tool_execution_update": {
      // Mid-run reconnect can miss tool_execution_start, so lazily create
      // the entry here too.
      const t = s.toolResults[ev.toolCallId] || {
        name: ev.toolName,
        running: true,
        text: "",
        isError: false,
        startedAt: Date.now(),
      };
      t.text = resultText(ev.partialResult);
      // details is a whole-state snapshot (not a delta) per pi-mono's
      // subagent extension, so a wholesale replacement is correct here.
      if (ev.partialResult?.details !== undefined) {
        t.details = ev.partialResult.details;
      }
      s.toolResults[ev.toolCallId] = t;
      break;
    }
    case "queue_update":
      // Fires both when we enqueue (steer/follow_up accepted) and when pi
      // delivers a queued message into the conversation. Deliberately not
      // refetching get_messages here: it fires mid-stream, and a wholesale
      // message replacement would invalidate currentIndex and drop running
      // tool results. Delivered messages land via the agent_settled refetch.
      s.queue = {
        steering: ev.steering || [],
        followUp: ev.followUp || [],
      };
      break;

    case "extension_ui_request":
      handleExtensionUiRequest(conn, ev);
      break;

    case "pi_web_process_error":
      s.processError = { message: ev.message, exitCode: ev.exitCode };
      break;

    case "tool_execution_end": {
      const r = s.toolResults[ev.toolCallId] || { name: ev.toolName };
      r.running = false;
      r.text = resultText(ev.result);
      r.isError = !!ev.isError;
      r.details = ev.result?.details;
      r.endedAt = Date.now();
      s.toolResults[ev.toolCallId] = r;
      // Sub-agent extensions (e.g. pi-mono's examples/extensions/subagent)
      // spawn separate pi processes whose token usage isn't counted in this
      // session's own get_session_stats — refresh so totals stay current
      // and the usage popover picks up any per-agent breakdown.
      if (r.details?.results) {
        sendTo(conn, { type: "get_session_stats" });
      }
      break;
    }
  }
}

// Extension UI sub-protocol (see "Extension UI Protocol" in pi's docs/rpc.md).
// Dialog methods block the agent until answered; fire-and-forget methods are
// informational. Methods that only make sense in a terminal (setStatus,
// setWidget, setTitle) are ignored.
function handleExtensionUiRequest(conn, ev) {
  const s = conn.state;
  switch (ev.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      s.uiRequests.push(ev);
      break;
    case "notify": {
      const notice = {
        id: ev.id,
        message: ev.message,
        notifyType: ev.notifyType || "info",
      };
      s.uiNotices.push(notice);
      setTimeout(() => {
        s.uiNotices = s.uiNotices.filter((n) => n !== notice);
      }, 6000);
      break;
    }
    case "set_editor_text":
      // Mirrors the TUI: extension asks to prefill the input editor.
      s.composerDraft = ev.text || "";
      break;
  }
}

function handleResponse(conn, ev) {
  const s = conn.state;
  if (ev.id && pending.has(ev.id)) {
    const { resolve, reject } = pending.get(ev.id);
    pending.delete(ev.id);
    if (ev.success) resolve(ev.data);
    else reject(new Error(ev.error));
    return;
  }
  if (!ev.success) {
    console.warn("pi rpc error:", ev.command, ev.error);
    return;
  }
  if (ev.command === "get_state") {
    s.model = ev.data.model || null;
    s.thinkingLevel = ev.data.thinkingLevel || null;
    s.streaming = ev.data.isStreaming;
    if (s.streaming) startStatsPolling(conn);
    else stopStatsPolling(conn);
    s.sessionName = ev.data.sessionName || null;
    s.processError = null;
  } else if (ev.command === "get_available_models") {
    s.availableModels = ev.data.models || [];
  } else if (ev.command === "get_session_stats") {
    s.sessionStats = ev.data || null;
    // Now that we know which session file this chat actually is, re-key the
    // conn so a later switchSession() to that path finds it (and its
    // process) instead of opening a duplicate.
    const file = ev.data?.sessionFile;
    if (file) rekeyConn(conn, file);
  } else if (ev.command === "get_commands") {
    s.commands = ev.data?.commands || [];
  } else if (ev.command === "get_fork_messages") {
    s.forkMessages = ev.data?.messages || [];
  } else if (
    ev.command === "set_model" ||
    ev.command === "set_thinking_level" ||
    ev.command === "cycle_model" ||
    ev.command === "cycle_thinking_level"
  ) {
    // These commands' response shapes vary by pi version; re-fetch the
    // authoritative state instead of trying to parse them individually.
    sendTo(conn, { type: "get_state" });
  } else if (ev.command === "new_session" || ev.command === "switch_session") {
    // Another client of this same process switched its session (e.g. a
    // second browser tab) — refetch everything for the new one.
    sendTo(conn, { type: "get_state" });
    sendTo(conn, { type: "get_messages" });
    sendTo(conn, { type: "get_session_stats" });
    sendTo(conn, { type: "get_fork_messages" });
    onSessionSwitched?.();
  } else if (ev.command === "get_messages") {
    s.messages = ev.data.messages;
    // Authoritative replacement: drop stale results so a chat can't keep
    // another session's tool output after a switch.
    s.toolResults = {};
    // Backfill tool results from history so past tool calls show output.
    for (const m of ev.data.messages) {
      if (m.role === "toolResult") {
        s.toolResults[m.toolCallId] = {
          name: m.toolName,
          running: false,
          text: resultText(m),
          isError: !!m.isError,
          details: m.details,
        };
      }
    }
  }
}

function resultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

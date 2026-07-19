// WebSocket client for the pi RPC protocol.
// The server is a transparent bridge: every WS text frame is one JSON line
// to/from `pi --mode rpc`. See pi's docs/rpc.md for the protocol.
// One project = one pi process = one `/ws/{projectId}` connection; switching
// the active project tears down the old socket and opens a new one.
import { reactive } from "vue";

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
  };
}

export const store = reactive(initialStore());

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Mirrors pi's BUILTIN_SLASH_COMMANDS (core/slash-commands.js). These are TUI-only
// commands with no RPC equivalent for most of them — listed here purely for
// discoverability in the composer's autocomplete; selecting one just inserts the
// command name, it isn't executed.
export const BUILTIN_SLASH_COMMANDS = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pi" },
];

let ws = null;
let currentProjectId = null;
// Index into store.messages of the assistant message currently streaming.
let currentIndex = -1;
// Called after new_session/switch_session completes, so the sidebar can
// refresh its chat-history list. Wired up once from App.vue.
let onSessionSwitched = null;

export function setOnSessionSwitched(fn) {
  onSessionSwitched = fn;
}

export function connectToProject(projectId) {
  if (ws) {
    ws.onclose = null; // don't auto-reconnect the socket we're intentionally closing
    ws.close();
    ws = null;
  }
  currentProjectId = projectId;
  currentIndex = -1;
  Object.assign(store, initialStore());
  connect();
}

// Tear down the active connection with no replacement (e.g. the current
// project was removed).
export function resetChat() {
  connectToProject(null);
}

function connect() {
  const projectId = currentProjectId;
  if (!projectId) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/${projectId}`);

  ws.onopen = () => {
    if (projectId !== currentProjectId) return;
    store.connected = true;
    send({ type: "get_state" });
    send({ type: "get_messages" });
    send({ type: "get_available_models" });
    send({ type: "get_session_stats" });
    send({ type: "get_commands" });
  };
  ws.onclose = () => {
    if (projectId !== currentProjectId) return;
    store.connected = false;
    setTimeout(() => {
      if (projectId === currentProjectId) connect();
    }, 1500);
  };
  ws.onmessage = (e) => {
    if (projectId !== currentProjectId) return;
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(ev);
  };
}

export function newSession() {
  send({ type: "new_session" });
}

export function switchSession(sessionPath) {
  send({ type: "switch_session", sessionPath });
}

export function send(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

// images: [{ mimeType, data }] with `data` as base64 (no data: prefix)
export function sendPrompt(text, images = []) {
  const imageBlocks = images.map((img) => ({
    type: "image",
    data: img.data,
    mimeType: img.mimeType,
  }));
  const content = text ? [{ type: "text", text }, ...imageBlocks] : imageBlocks;
  store.messages.push({ role: "user", content });
  const cmd = { type: "prompt", message: text };
  if (imageBlocks.length) cmd.images = imageBlocks;
  send(cmd);
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

function handle(ev) {
  switch (ev.type) {
    case "response":
      handleResponse(ev);
      break;

    case "agent_start":
      store.streaming = true;
      break;
    case "agent_settled":
      store.streaming = false;
      currentIndex = -1;
      send({ type: "get_session_stats" });
      break;

    case "message_start":
      if (ev.message.role === "assistant") {
        currentIndex = store.messages.push(ev.message) - 1;
      }
      break;
    case "message_update":
      if (currentIndex >= 0) {
        store.messages[currentIndex] = ev.message;
      }
      break;
    case "message_end":
      if (currentIndex >= 0 && ev.message.role === "assistant") {
        store.messages[currentIndex] = ev.message;
        currentIndex = -1;
      }
      break;

    case "tool_execution_start":
      store.toolResults[ev.toolCallId] = {
        name: ev.toolName,
        running: true,
        text: "",
        isError: false,
        startedAt: Date.now(),
      };
      break;
    case "tool_execution_update":
      if (store.toolResults[ev.toolCallId]) {
        store.toolResults[ev.toolCallId].text = resultText(ev.partialResult);
      }
      break;
    case "tool_execution_end": {
      const r = store.toolResults[ev.toolCallId] || { name: ev.toolName };
      r.running = false;
      r.text = resultText(ev.result);
      r.isError = !!ev.isError;
      r.details = ev.result?.details;
      r.endedAt = Date.now();
      store.toolResults[ev.toolCallId] = r;
      // Sub-agent extensions (e.g. pi-mono's examples/extensions/subagent)
      // spawn separate pi processes whose token usage isn't counted in this
      // session's own get_session_stats — refresh so totals stay current
      // and the usage popover picks up any per-agent breakdown.
      if (r.details?.results) {
        send({ type: "get_session_stats" });
      }
      break;
    }
  }
}

function handleResponse(ev) {
  if (!ev.success) {
    console.warn("pi rpc error:", ev.command, ev.error);
    return;
  }
  if (ev.command === "get_state") {
    store.model = ev.data.model || null;
    store.thinkingLevel = ev.data.thinkingLevel || null;
    store.streaming = ev.data.isStreaming;
    store.sessionName = ev.data.sessionName || null;
  } else if (ev.command === "get_available_models") {
    store.availableModels = ev.data.models || [];
  } else if (ev.command === "get_session_stats") {
    store.sessionStats = ev.data || null;
  } else if (ev.command === "get_commands") {
    store.commands = ev.data?.commands || [];
  } else if (
    ev.command === "set_model" ||
    ev.command === "set_thinking_level" ||
    ev.command === "cycle_model" ||
    ev.command === "cycle_thinking_level"
  ) {
    // These commands' response shapes vary by pi version; re-fetch the
    // authoritative state instead of trying to parse them individually.
    send({ type: "get_state" });
  } else if (ev.command === "new_session" || ev.command === "switch_session") {
    store.messages = [];
    store.toolResults = {};
    send({ type: "get_state" });
    send({ type: "get_messages" });
    send({ type: "get_session_stats" });
    onSessionSwitched?.();
  } else if (ev.command === "get_messages") {
    store.messages = ev.data.messages;
    // Backfill tool results from history so past tool calls show output.
    for (const m of ev.data.messages) {
      if (m.role === "toolResult") {
        store.toolResults[m.toolCallId] = {
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

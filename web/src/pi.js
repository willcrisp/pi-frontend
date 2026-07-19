// WebSocket client for the pi RPC protocol.
// The server is a transparent bridge: every WS text frame is one JSON line
// to/from `pi --mode rpc`. See pi's docs/rpc.md for the protocol.
import { reactive } from "vue";

export const store = reactive({
  connected: false,
  streaming: false,
  model: null,
  thinkingLevel: null,
  availableModels: [],
  sessionName: null,
  messages: [],
  // toolCallId -> { name, running, text, isError }
  toolResults: {},
});

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

let ws = null;
// Index into store.messages of the assistant message currently streaming.
let currentIndex = -1;

export function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    store.connected = true;
    send({ type: "get_state" });
    send({ type: "get_messages" });
    send({ type: "get_available_models" });
  };
  ws.onclose = () => {
    store.connected = false;
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(ev);
  };
}

export function send(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

export function sendPrompt(text) {
  store.messages.push({ role: "user", content: [{ type: "text", text }] });
  send({ type: "prompt", message: text });
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
      store.toolResults[ev.toolCallId] = r;
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
  } else if (
    ev.command === "set_model" ||
    ev.command === "set_thinking_level" ||
    ev.command === "cycle_model" ||
    ev.command === "cycle_thinking_level"
  ) {
    // These commands' response shapes vary by pi version; re-fetch the
    // authoritative state instead of trying to parse them individually.
    send({ type: "get_state" });
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

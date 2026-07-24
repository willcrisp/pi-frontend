// OpenCode V2 Client Store
// Direct HTTP REST + SSE EventSource client for OpenCode V2 API surface (/api/*).
import { reactive } from "vue";

export const opencodeStore = reactive({
  connected: false,
  activeSessionId: null,
  activeSession: null,
  messages: [],
  forkMessages: [],
  isStreaming: false,
  availableModels: [],
  selectedModel: null,
  availableAgents: [],
  selectedAgent: "opencode",
  draft: "",
  error: null,
  sessionStats: {
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextUsage: { percent: 0 },
  },
  toolResults: {},
  commands: [],
});

let eventSource = null;

// Helper function for subagent details compatibility
export function subagentDetails(result) {
  if (!result) return null;
  return result.details || null;
}

// Initialize connection & metadata from OpenCode V2 server
export async function initOpenCode() {
  try {
    const healthRes = await fetch("/api/health");
    opencodeStore.connected = healthRes.ok;
  } catch (err) {
    opencodeStore.connected = false;
    opencodeStore.error = "Failed to reach OpenCode V2 server at /api/health";
  }

  await Promise.all([loadModels(), loadAgents()]);
  setupEventStream();
}

// Fetch available LLM models from OpenCode V2
export async function loadModels() {
  try {
    const res = await fetch("/api/model");
    if (res.ok) {
      const data = await res.json();
      opencodeStore.availableModels = Array.isArray(data) ? data : data.models || [];
      if (opencodeStore.availableModels.length > 0 && !opencodeStore.selectedModel) {
        const first = opencodeStore.availableModels[0];
        opencodeStore.selectedModel = typeof first === "object" ? first.id || first.name : first;
      }
    }
  } catch (err) {
    console.warn("Could not load OpenCode models:", err);
  }
}

// Fetch available built-in agents from OpenCode V2
export async function loadAgents() {
  try {
    const res = await fetch("/api/agent");
    if (res.ok) {
      const data = await res.json();
      opencodeStore.availableAgents = Array.isArray(data) ? data : data.agents || [];
    }
  } catch (err) {
    console.warn("Could not load OpenCode agents:", err);
  }
}

// Subscribe to global / session event stream via Server-Sent Events
function setupEventStream() {
  if (eventSource) return;

  try {
    eventSource = new EventSource("/api/event");

    eventSource.onopen = () => {
      opencodeStore.connected = true;
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload);
      } catch (e) {
        console.error("Failed to parse SSE payload:", e);
      }
    };

    eventSource.onerror = () => {
      opencodeStore.connected = false;
    };
  } catch (e) {
    console.warn("EventSource subscription failed:", e);
  }
}

// Process real-time events streamed from OpenCode V2
function handleServerEvent(event) {
  if (!event) return;
  const { type, sessionID, messageID, data, delta, text, usage } = event;

  if (sessionID && opencodeStore.activeSessionId && sessionID !== opencodeStore.activeSessionId) {
    return;
  }

  // Update token usage stats if available in SSE event
  if (usage) {
    const input = usage.inputTokens || usage.input || 0;
    const output = usage.outputTokens || usage.output || 0;
    opencodeStore.sessionStats.tokens.input += input;
    opencodeStore.sessionStats.tokens.output += output;
    opencodeStore.sessionStats.tokens.total += input + output;
  }

  switch (type) {
    case "message.delta":
    case "text.delta":
    case "part.delta": {
      opencodeStore.isStreaming = true;
      const chunk = text || delta || (data && data.text) || "";
      if (chunk) {
        const lastMsg = opencodeStore.messages[opencodeStore.messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          lastMsg.text = (lastMsg.text || "") + chunk;
        } else {
          opencodeStore.messages.push({
            id: messageID || `msg-${Date.now()}`,
            role: "assistant",
            text: chunk,
          });
        }
      }
      break;
    }

    case "session.idle":
    case "turn.complete":
    case "agent.settled": {
      opencodeStore.isStreaming = false;
      break;
    }

    case "session.updated":
    case "message.created": {
      refreshActiveMessages();
      break;
    }
  }
}

// Load message history for a specific session
export async function connectToSession(sessionID) {
  if (!sessionID) return;
  opencodeStore.activeSessionId = sessionID;
  opencodeStore.isStreaming = false;

  await refreshActiveMessages();
}

export async function refreshActiveMessages() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;

  try {
    const res = await fetch(`/api/session/${sessionID}/message`);
    if (res.ok) {
      const rawMessages = await res.json();
      const list = Array.isArray(rawMessages) ? rawMessages : rawMessages.messages || [];
      opencodeStore.messages = list.map(normalizeMessage);
      opencodeStore.forkMessages = opencodeStore.messages
        .filter((m) => m.role === "user")
        .map((m, idx) => ({ entryId: m.id || idx, text: m.text }));
    }
  } catch (err) {
    console.error(`Failed to fetch messages for session ${sessionID}:`, err);
  }
}

// Format message objects uniformly for Vue components
function normalizeMessage(msg) {
  if (typeof msg === "string") {
    return { id: `msg-${Math.random()}`, role: "user", text: msg };
  }
  let role = msg.role || (msg.type === "user" ? "user" : "assistant");
  let text = msg.text || msg.content || "";

  if (!text && Array.isArray(msg.parts)) {
    text = msg.parts
      .filter((p) => p.type === "text" || p.text)
      .map((p) => p.text || "")
      .join("\n");
  }

  return {
    id: msg.id || msg.messageID || `msg-${Date.now()}`,
    role,
    text,
    parts: msg.parts || [],
    toolCalls: msg.toolCalls || [],
    createdAt: msg.createdAt || null,
  };
}

// Send user prompt to OpenCode V2 session
export async function sendPrompt(text) {
  if (!text || !text.trim() || !opencodeStore.activeSessionId) return;
  const sessionID = opencodeStore.activeSessionId;

  const promptText = text.trim();
  opencodeStore.draft = "";

  // Optimistically display user message
  const userMsgId = `user-${Date.now()}`;
  opencodeStore.messages.push({
    id: userMsgId,
    role: "user",
    text: promptText,
  });

  opencodeStore.forkMessages.push({ entryId: userMsgId, text: promptText });
  opencodeStore.isStreaming = true;

  try {
    const res = await fetch(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: promptText }],
        model: opencodeStore.selectedModel || undefined,
        agent: opencodeStore.selectedAgent || undefined,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to send prompt (${res.status})`);
    }
  } catch (err) {
    opencodeStore.isStreaming = false;
    opencodeStore.error = err.message;
    console.error("Error sending prompt to OpenCode:", err);
  }
}

// Interrupt active running execution
export async function abortSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;

  try {
    await fetch(`/api/session/${sessionID}/interrupt`, { method: "POST" });
  } catch (err) {
    console.error("Failed to interrupt session:", err);
  } finally {
    opencodeStore.isStreaming = false;
  }
}

// Select/switch model for session
export async function setModel(modelId) {
  opencodeStore.selectedModel = modelId;
  const sessionID = opencodeStore.activeSessionId;
  if (sessionID && modelId) {
    try {
      await fetch(`/api/session/${sessionID}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
      });
    } catch (e) {
      console.warn("Failed to update session model on server:", e);
    }
  }
}

// Select/switch agent for session
export async function setAgent(agentId) {
  opencodeStore.selectedAgent = agentId;
  const sessionID = opencodeStore.activeSessionId;
  if (sessionID && agentId) {
    try {
      await fetch(`/api/session/${sessionID}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentId }),
      });
    } catch (e) {
      console.warn("Failed to update session agent on server:", e);
    }
  }
}

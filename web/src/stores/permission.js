// Permission-gating store: tool calls that need approval arrive as
// `permission.*` SSE events (see opencode.js#handleServerEvent) and queue
// here until the user responds. Without this, a tool call needing approval
// hangs the UI indefinitely with no prompt.
import { reactive } from "vue";
import { apiBase, authHeaders } from "./ssh.js";

export const permissionStore = reactive({
  queue: [], // [{ id, sessionID, tool, arguments, receivedAt, error }]
});

// Called by opencode.js#handleServerEvent for any `permission.*` event.
export function enqueue(event) {
  const data = (event && event.data) || {};
  const id = data.id || data.permissionID || event.id;
  if (!id) return;
  if (permissionStore.queue.some((p) => p.id === id)) return;
  permissionStore.queue.push({
    id,
    sessionID: data.sessionID || "",
    tool: data.tool || (data.metadata && data.metadata.tool) || "unknown tool",
    arguments: data.arguments ?? data.metadata ?? {},
    receivedAt: Date.now(),
    error: null,
  });
}

// UNVERIFIED against /doc — see docs/opencode-api.md
export async function respond(permissionID, response) {
  const entry = permissionStore.queue.find((p) => p.id === permissionID);
  if (!entry) return;
  try {
    const res = await fetch(
      `${apiBase()}/session/${entry.sessionID}/permission/${permissionID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ response }),
      }
    );
    if (res.ok) {
      permissionStore.queue = permissionStore.queue.filter((p) => p.id !== permissionID);
      return;
    }
    entry.error = `Failed to respond (${res.status})`;
  } catch (err) {
    entry.error = err.message || "Failed to respond to permission request";
  }
}

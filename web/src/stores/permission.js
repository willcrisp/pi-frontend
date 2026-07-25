// Permission-gating store: tool calls that need approval arrive as the
// `permission.v2.asked` SSE event (see opencode.js#handleServerEvent) and
// queue here until the user responds. Without this, a tool call needing
// approval hangs the UI indefinitely with no prompt.
import { reactive } from "vue";
import { apiBase, authHeaders } from "./ssh.js";

export const permissionStore = reactive({
  queue: [], // [{ id, sessionID, action, resources, save, metadata, source, receivedAt, error }]
});

// Only `permission.v2.asked` enqueues; `permission.v2.replied` is the outbound
// confirmation and clears the entry below.
export function handlePermissionEvent(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};
  if (type === "permission.v2.asked") {
    if (!data.id || permissionStore.queue.some((p) => p.id === data.id)) return;
    permissionStore.queue.push({
      id: data.id,
      sessionID: data.sessionID || "",
      action: data.action || "",
      resources: Array.isArray(data.resources) ? data.resources : [],
      save: Array.isArray(data.save) ? data.save : [],
      metadata: data.metadata || {},
      source: data.source || null,
      receivedAt: Date.now(),
      error: null,
    });
  } else if (type === "permission.v2.replied") {
    permissionStore.queue = permissionStore.queue.filter((p) => p.id !== data.requestID);
  }
}

// PermissionV2.Reply is an enum: "once" | "always" | "reject".
export async function respond(permissionID, reply) {
  const entry = permissionStore.queue.find((p) => p.id === permissionID);
  if (!entry) return;
  entry.error = null;
  try {
    const res = await fetch(
      `${apiBase()}/session/${entry.sessionID}/permission/${permissionID}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ reply }),
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

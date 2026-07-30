// Permission-gating store: tool calls that need approval arrive as the
// `permission.v2.asked` SSE event (see opencode.js#handleServerEvent) and
// queue here until the user responds. Without this, a tool call needing
// approval hangs the UI indefinitely with no prompt.
import { reactive } from "vue";
import { apiGet, apiPost, apiDelete, unwrap } from "../lib/api.js";

export const permissionStore = reactive({
  queue: [], // [{ id, sessionID, action, resources, save, metadata, source, receivedAt, error, busy }]
  // "Allow always" rules the server has persisted. Without a way to list and
  // revoke these, a single mis-click grants a tool forever with no route back.
  saved: [],
  savedLoading: false,
  savedError: null,
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
      // A reply is in flight. The dialog disables on it, so a double-click (or a
      // held-down number key) can't send the same decision twice — which on
      // "always" would mean two saved rules.
      busy: false,
    });
  } else if (type === "permission.v2.replied") {
    permissionStore.queue = permissionStore.queue.filter((p) => p.id !== data.requestID);
  }
}

// GET /api/permission/saved — the persisted always-allow rules.
export async function loadSavedPermissions() {
  permissionStore.savedLoading = true;
  permissionStore.savedError = null;
  try {
    const res = await apiGet("/permission/saved");
    if (!res.ok) {
      permissionStore.savedError = `Failed to load saved rules (${res.status})`;
      return;
    }
    permissionStore.saved = unwrap(await res.json());
  } catch (err) {
    permissionStore.savedError = err.message || "Failed to load saved rules";
  } finally {
    permissionStore.savedLoading = false;
  }
}

// DELETE /api/permission/saved/{id} — revoke one rule.
export async function revokeSavedPermission(id) {
  permissionStore.savedError = null;
  try {
    const res = await apiDelete(`/permission/saved/${encodeURIComponent(id)}`);
    if (!res.ok) {
      permissionStore.savedError = `Failed to revoke rule (${res.status})`;
      return;
    }
    await loadSavedPermissions();
  } catch (err) {
    permissionStore.savedError = err.message || "Failed to revoke rule";
  }
}

// PermissionV2.Reply is an enum: "once" | "always" | "reject".
export async function respond(permissionID, reply) {
  const entry = permissionStore.queue.find((p) => p.id === permissionID);
  if (!entry || entry.busy) return;
  entry.error = null;
  entry.busy = true;
  try {
    const res = await apiPost(
      `/session/${entry.sessionID}/permission/${permissionID}/reply`,
      { reply }
    );
    if (res.ok) {
      permissionStore.queue = permissionStore.queue.filter((p) => p.id !== permissionID);
      return;
    }
    entry.error = `Failed to respond (${res.status})`;
  } catch (err) {
    entry.error = err.message || "Failed to respond to permission request";
  } finally {
    // Only matters on the failure paths — a success removed the entry — but it
    // must be cleared there or the dialog stays disabled with an error and no
    // way to retry.
    entry.busy = false;
  }
}

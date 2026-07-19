// REST client + reactive store for the local `coder` CLI integration: lists
// the user's Coder cloud workspaces and starts/stops them (see /api/coder in
// server/src/main.rs). This is independent of the pi project bridge — these
// are Coder's own cloud machines, unrelated to where pi runs. `coder` is
// expected to be installed and logged in on the machine running the server.
import { reactive } from "vue";

export const coderStore = reactive({
  available: false, // is the coder CLI usable (installed + logged in)?
  error: "", // reason it isn't, if available === false
  workspaces: [], // [{ id, name, owner, status, outdated }]
  loading: false,
  loaded: false,
  pending: {}, // { [id]: "start" | "stop" } — optimistic transition in flight
});

// Statuses where the workspace is in motion and no action should be offered.
const BUSY = ["starting", "stopping", "pending", "canceling", "deleting"];

export function isRunning(ws) {
  return ws.status === "running";
}

export function isBusy(ws) {
  return BUSY.includes(ws.status) || !!coderStore.pending[ws.id];
}

export async function fetchWorkspaces() {
  coderStore.loading = true;
  try {
    const res = await fetch("/api/coder/workspaces");
    if (!res.ok) {
      coderStore.available = false;
      coderStore.error = `failed to reach server (${res.status})`;
      coderStore.workspaces = [];
      return;
    }
    const data = await res.json();
    coderStore.available = !!data.available;
    coderStore.error = data.error || "";
    coderStore.workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    // Drop optimistic markers once the real status reflects the transition.
    for (const ws of coderStore.workspaces) {
      const p = coderStore.pending[ws.id];
      if (p === "start" && ws.status !== "stopped" && ws.status !== "failed") delete coderStore.pending[ws.id];
      if (p === "stop" && ws.status !== "running") delete coderStore.pending[ws.id];
    }
  } catch (e) {
    coderStore.available = false;
    coderStore.error = e.message || String(e);
    coderStore.workspaces = [];
  } finally {
    coderStore.loading = false;
    coderStore.loaded = true;
  }
}

async function transition(id, verb) {
  coderStore.pending[id] = verb;
  try {
    const res = await fetch(`/api/coder/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: id }),
    });
    if (!res.ok) {
      delete coderStore.pending[id];
      const message = await res.text().catch(() => "");
      throw new Error(message || `coder ${verb} failed (${res.status})`);
    }
    // Refresh soon after so the "starting"/"stopping" status shows up.
    setTimeout(fetchWorkspaces, 1200);
  } catch (e) {
    delete coderStore.pending[id];
    throw e;
  }
}

export function startWorkspace(id) {
  return transition(id, "start");
}

export function stopWorkspace(id) {
  return transition(id, "stop");
}

// REST client + reactive store for the read-only Serena monitoring status
// (GET /api/serena/status in server/src/main.rs — probes Serena's dashboard
// HTTP ports and scans known project paths for `.serena/cache/`). Mirrors
// the conventions in ssh.js: a flat reactive store, one fetch function, a
// loading/error field pair.
//
// Key exports:
//   serenaStore        — {connected, instances, tokenEstimator, toolStats,
//                          indexedProjects, loading, loaded, error}
//   fetchSerenaStatus() — GET /api/serena/status, populates the store
import { reactive } from "vue";

export const serenaStore = reactive({
  connected: false,
  instances: [],
  tokenEstimator: null,
  toolStats: [],
  indexedProjects: [],
  loading: false,
  loaded: false,
  error: "",
});

export async function fetchSerenaStatus() {
  serenaStore.loading = true;
  serenaStore.error = "";
  try {
    const res = await fetch("/api/serena/status");
    if (!res.ok) throw new Error(`failed to load serena status (${res.status})`);
    const data = await res.json();
    serenaStore.connected = !!data.connected;
    serenaStore.instances = data.instances || [];
    serenaStore.tokenEstimator = data.tokenEstimator || null;
    serenaStore.toolStats = data.toolStats || [];
    serenaStore.indexedProjects = data.indexedProjects || [];
    serenaStore.loaded = true;
  } catch (e) {
    serenaStore.error = e.message || String(e);
  } finally {
    serenaStore.loading = false;
  }
}

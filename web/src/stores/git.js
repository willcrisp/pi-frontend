// REST client + reactive store for the current project's git branch (see
// /api/projects/{id}/git/branches and /git/checkout in server/src/main.rs).
// Read-only listing plus plain `git checkout <branch>` — no fetch/pull/create.
import { reactive } from "vue";

export const gitStore = reactive({
  projectId: null, // project these branches belong to, so stale responses can be dropped
  available: false, // is the project dir a git repo (branches listed successfully at least once)?
  error: "",
  current: null,
  branches: [],
  loading: false,
  loaded: false,
  switching: false,
});

export async function fetchBranches(projectId) {
  if (!projectId) return;
  gitStore.loading = true;
  try {
    const res = await fetch(`/api/projects/${projectId}/git/branches`);
    gitStore.projectId = projectId;
    if (!res.ok) {
      gitStore.available = false;
      gitStore.error = `failed to reach server (${res.status})`;
      gitStore.branches = [];
      gitStore.current = null;
      return;
    }
    const data = await res.json();
    gitStore.current = data.current || null;
    gitStore.branches = Array.isArray(data.branches) ? data.branches : [];
    gitStore.error = data.error || "";
    gitStore.available = !data.error && gitStore.branches.length > 0;
  } catch (e) {
    gitStore.available = false;
    gitStore.error = e.message || String(e);
    gitStore.branches = [];
    gitStore.current = null;
  } finally {
    gitStore.loading = false;
    gitStore.loaded = true;
  }
}

export async function checkoutBranch(projectId, branch) {
  gitStore.switching = true;
  try {
    const res = await fetch(`/api/projects/${projectId}/git/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `checkout failed (${res.status})`);
    }
    gitStore.current = data.current;
    return data;
  } finally {
    gitStore.switching = false;
  }
}

export function resetGitStore() {
  gitStore.projectId = null;
  gitStore.available = false;
  gitStore.error = "";
  gitStore.current = null;
  gitStore.branches = [];
  gitStore.loaded = false;
}

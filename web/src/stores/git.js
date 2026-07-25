// Per-directory git branch info, fetched via the PTY runner (see pty.js) and cached in
// localStorage so switching chats shows a branch instantly while a fresh fetch runs in
// the background. Mirrors the old Pi-era git.js store's shape, sourced over PTY instead
// of a Pi-only /api/projects/{id}/git/* endpoint (opencode2 has no such route).
import { reactive } from "vue";
import { runCommand } from "./pty.js";
import { apiBase, authHeaders } from "./ssh.js";

const CACHE_KEY = "opencode-web:git-cache"; // { [directory]: { current, branches, fetchedAt } }

export const gitStore = reactive({
  // directory -> { current, branches, loading, switching, error }
  byDirectory: {},
});

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function entry(directory) {
  if (!gitStore.byDirectory[directory]) {
    const cache = loadCache();
    const cached = cache[directory];
    gitStore.byDirectory[directory] = {
      current: cached?.current || "",
      branches: cached?.branches || [],
      loading: false,
      switching: false,
      error: "",
    };
  }
  return gitStore.byDirectory[directory];
}

function parseBranches(output) {
  const branches = [];
  let current = "";
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const isCurrent = line.startsWith("*");
    const name = line.replace(/^\*\s*/, "").replace(/^remotes\//, "").trim();
    if (!name || name.includes("->")) continue;
    if (isCurrent) current = name;
    if (!branches.includes(name)) branches.push(name);
  }
  return { current, branches };
}

// Try the dedicated vcs branches route first; returns null (not an error) on
// a 404 or an unexpected response shape so the caller can fall back to PTY.
// UNVERIFIED against /doc — see docs/opencode-api.md
async function fetchBranchesViaRoute(directory) {
  try {
    const res = await fetch(`${apiBase()}/vcs/branches?directory=${encodeURIComponent(directory)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const payload = body && body.data ? body.data : body;
    if (!payload || !Array.isArray(payload.branches)) return null;
    return { current: payload.current || "", branches: payload.branches };
  } catch {
    return null;
  }
}

// Reads localStorage cache immediately (if any), then kicks off a background refresh.
// Call this on chat/session select; UI should render `gitStore.byDirectory[directory]`
// reactively rather than awaiting this directly.
export function fetchBranches(directory) {
  if (!directory) return;
  const state = entry(directory);
  state.loading = true;
  state.error = "";

  (async () => {
    const viaRoute = await fetchBranchesViaRoute(directory);
    if (viaRoute) return viaRoute;
    return parseBranches(await runCommand(directory, "git", ["branch", "-a"]));
  })()
    .then(({ current, branches }) => {
      state.current = current || state.current;
      state.branches = branches.length ? branches : state.branches;
      state.loading = false;

      const cache = loadCache();
      cache[directory] = { current: state.current, branches: state.branches, fetchedAt: Date.now() };
      saveCache(cache);
    })
    .catch((err) => {
      state.loading = false;
      state.error = err.message || "git branch -a failed";
    });
}

// UNVERIFIED against /doc — see docs/opencode-api.md
async function checkoutBranchViaRoute(directory, branch) {
  try {
    const res = await fetch(`${apiBase()}/vcs/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ directory, branch }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkoutBranch(directory, branch) {
  const state = entry(directory);
  state.switching = true;
  state.error = "";
  try {
    const ok = await checkoutBranchViaRoute(directory, branch);
    if (!ok) await runCommand(directory, "git", ["checkout", branch]);
    state.current = branch;
    const cache = loadCache();
    cache[directory] = { current: state.current, branches: state.branches, fetchedAt: Date.now() };
    saveCache(cache);
  } catch (err) {
    state.error = err.message || `git checkout ${branch} failed`;
    throw err;
  } finally {
    state.switching = false;
  }
}

export function gitStateFor(directory) {
  return entry(directory);
}

// Per-directory git branch info, fetched via the PTY runner (see pty.js) and cached in
// localStorage so switching chats shows a branch instantly while a fresh fetch runs in
// the background. Sourced over PTY rather than a Pi-only /api/projects/{id}/git/*
// endpoint, since opencode2 exposes no git route.
//
// READ-ONLY by design: this store only ever runs `git branch`. Checking out from the
// UI mutates a real working tree the agent may be mid-task in, and one stray click on
// a header badge is enough to do it — so no checkout helper lives here.
import { reactive } from "vue";
import { runCommand } from "./pty.js";
import { readJSON, writeJSON } from "../lib/storage.js";

const CACHE_KEY = "opencode-web:git-cache"; // { [directory]: { current, branches, fetchedAt } }

export const gitStore = reactive({
  // directory -> { current, branches, loading, error }
  byDirectory: {},
});

const loadCache = () => readJSON(CACHE_KEY, {}) || {};

function entry(directory) {
  if (!gitStore.byDirectory[directory]) {
    const cache = loadCache();
    const cached = cache[directory];
    gitStore.byDirectory[directory] = {
      current: cached?.current || "",
      branches: cached?.branches || [],
      loading: false,
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

// Reads localStorage cache immediately (if any), then kicks off a background refresh.
// Call this on chat/session select; UI should render `gitStore.byDirectory[directory]`
// reactively rather than awaiting this directly.
export function fetchBranches(directory) {
  if (!directory) return;
  const state = entry(directory);
  state.loading = true;
  state.error = "";

  // --no-pager: with a PTY attached git would page through `less`, which wraps the
  // output in terminal mode-switch escapes instead of printing it plainly.
  runCommand(directory, "git", ["--no-pager", "branch", "-a"])
    .then((output) => {
      const { current, branches } = parseBranches(output);
      state.current = current || state.current;
      state.branches = branches.length ? branches : state.branches;
      state.loading = false;

      const cache = loadCache();
      cache[directory] = { current: state.current, branches: state.branches, fetchedAt: Date.now() };
      writeJSON(CACHE_KEY, cache);
    })
    .catch((err) => {
      state.loading = false;
      state.error = err.message || "git branch failed";
    });
}

export function gitStateFor(directory) {
  return entry(directory);
}

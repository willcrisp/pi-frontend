// Per-directory remote file listing for fuzzy search, fetched via the PTY runner
// (fdfind, with fd / git ls-files fallbacks) and cached in localStorage so the
// palette has results instantly; refresh runs in the background on demand.
import { reactive } from "vue";
import { runCommand } from "./pty.js";

const CACHE_KEY = "opencode-web:files-cache"; // { [directory]: { files, fetchedAt } }
const MAX_CACHED_FILES = 20000;

export const fileSearchStore = reactive({
  // directory -> { files: string[], loading, error }
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
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // quota exceeded on a huge tree — drop other directories and retry once
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({}));
    } catch {}
  }
}

// PTY output is a terminal stream, not clean stdout: it can carry the echoed
// command line, shell prompt, ANSI/OSC escape sequences, and \r line endings.
// Strip the escapes and control bytes so line-based parsing sees real paths.
function cleanPtyOutput(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (title set etc.)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (colors, cursor moves)
    .replace(/\x1b[@-Z\\-_]/g, "") // bare two-byte escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function entry(directory) {
  if (!fileSearchStore.byDirectory[directory]) {
    const cached = loadCache()[directory];
    fileSearchStore.byDirectory[directory] = {
      files: cached?.files || [],
      loading: false,
      error: "",
    };
  }
  return fileSearchStore.byDirectory[directory];
}

// Debian/Ubuntu installs sharkdp fd as `fdfind`; try that first, then `fd`,
// then `git ls-files` (tracked files only) as a last resort.
const LISTING_COMMANDS = [
  ["fdfind", ["--type", "f", "--hidden", "--exclude", ".git"]],
  ["fd", ["--type", "f", "--hidden", "--exclude", ".git"]],
  ["git", ["ls-files"]],
];

async function listFiles(directory) {
  let lastErr = null;
  for (const [cmd, args] of LISTING_COMMANDS) {
    try {
      const output = await runCommand(directory, cmd, args, { timeoutMs: 30000 });
      const files = cleanPtyOutput(output)
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trim())
        .filter(Boolean);
      if (files.length) return files.slice(0, MAX_CACHED_FILES);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("no file listing command succeeded");
}

export function refreshFiles(directory) {
  if (!directory) return;
  const state = entry(directory);
  if (state.loading) return;
  state.loading = true;
  state.error = "";
  listFiles(directory)
    .then((files) => {
      state.files = files;
      state.loading = false;
      const cache = loadCache();
      cache[directory] = { files, fetchedAt: Date.now() };
      saveCache(cache);
    })
    .catch((err) => {
      state.loading = false;
      state.error = err.message || "file listing failed";
    });
}

export function filesFor(directory) {
  return entry(directory);
}

// --- Directory suggestions for the add-project path field ---------------------
// Lists immediate subdirectories of `parent` on the connected server via the
// PTY runner (`find -maxdepth 1 -type d` — no shell involved, so the typed
// path needs no quoting). Cached in-memory per parent for the session.

const dirCache = new Map(); // parent -> string[] (absolute paths)

// The PTY stream also echoes the command line and shell prompt, so only keep
// lines that are actual absolute paths inside `parent` (the echoed
// `find /x -maxdepth ...` and `user@host:~$` lines never start with `parent/`).
function parseFindOutput(output, parent) {
  const prefix = parent === "/" ? "/" : `${parent}/`;
  const seen = new Set();
  for (const raw of cleanPtyOutput(output).split("\n")) {
    const line = raw.replace(/\/+$/, "").trim();
    if (!line || line === parent) continue;
    if (!line.startsWith(prefix) || line.length <= prefix.length) continue;
    // direct children only (find -maxdepth 1 guarantees this; ls output is
    // joined below so it also holds)
    seen.add(line);
  }
  return [...seen];
}

async function runDirListing(parent) {
  try {
    const output = await runCommand("/", "find", [parent, "-maxdepth", "1", "-type", "d"], {
      timeoutMs: 10000,
    });
    const dirs = parseFindOutput(output, parent);
    if (dirs.length) return dirs;
  } catch {
    // fall through to ls
  }
  // Fallback for servers without a usable `find`: `ls -1p` from inside the
  // parent; entries ending in "/" are directories.
  const output = await runCommand(parent, "ls", ["-1p"], { timeoutMs: 10000 });
  const prefix = parent === "/" ? "/" : `${parent}/`;
  return [
    ...new Set(
      cleanPtyOutput(output)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith("/"))
        .map((l) => prefix + l.replace(/\/+$/, ""))
        .filter((d) => d.length > prefix.length)
    ),
  ];
}

export async function listDirectories(parent) {
  if (!parent) return [];
  if (dirCache.has(parent)) return dirCache.get(parent);
  try {
    const dirs = await runDirListing(parent);
    // don't cache empty/failed lookups so a transient error can recover
    if (dirs.length) dirCache.set(parent, dirs);
    return dirs;
  } catch {
    return [];
  }
}

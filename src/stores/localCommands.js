// Command files on disk, for the composer's "/" menu.
//
// `GET /api/command` lists the commands the *server* knows about, and opencode
// reads its config once at startup — so a command file added since the server
// booted is invisible to that route while being perfectly real on disk. The "/"
// menu is where you go looking for it, and finding nothing there reads as "that
// command doesn't exist" rather than "restart the server".
//
// So the files are read directly, the same way sub-agent definitions are
// (subagents.js): over the PTY, because V2 has no route that lists them.
//
//   project:  <session directory>/.opencode/command/**/*.md
//   global:   ~/.config/opencode/command/**/*.md
//
// Recursive, because a subdirectory namespaces the command:
// `.opencode/command/git/commit.md` is `/git/commit`.
//
// A file's `description:` frontmatter key is what the menu shows; failing that,
// its first line of prose. Nothing else in the file is parsed — choosing a
// command puts `/<name> ` in the composer and the server expands it, exactly as
// it does for a command from the catalog. This store supplies names, not
// behaviour.
//
// Results are cached per project directory in localStorage so the menu is
// populated on the first keystroke after a reload rather than after a PTY
// round-trip.
import { reactive } from "vue";
import { activeSessionDirectory } from "./projects.js";
import { readMarkdownDirs } from "./remotefs.js";
import { readJSON, writeJSON } from "../lib/storage.js";

const CACHE_KEY = "opencode-web:local-commands"; // { [directory]: {commands, fetchedAt} }

export const localCommandsStore = reactive({
  // [{ name, description, path, scope }]
  commands: [],
  loading: false,
  error: "",
});

export const PROJECT_DIR = ".opencode/command";
export const GLOBAL_DIR = "~/.config/opencode/command";

// Both the singular and plural spellings are accepted, matching subagents.js —
// opencode's own loader takes either.
function scopeDirs(projectDirectory) {
  const dirs = [];
  if (projectDirectory) {
    const root = projectDirectory.replace(/\/+$/, "");
    dirs.push(
      { scope: "project", dir: `${root}/.opencode/command` },
      { scope: "project", dir: `${root}/.opencode/commands` }
    );
  }
  dirs.push(
    { scope: "global", dir: GLOBAL_DIR },
    { scope: "global", dir: "~/.config/opencode/commands" }
  );
  return dirs;
}

// `ls`/`find` print the expanded path, so a `~`-rooted directory comes back
// absolute; compare on the part after the tilde (as subagents.js does).
function stripTilde(dir) {
  return dir.startsWith("~/") ? dir.slice(1) : dir;
}

// The command name for a file: its path below the command directory, minus the
// extension. A subdirectory stays in the name — that is how opencode namespaces
// them, and flattening would collide `git/commit` with `jj/commit`.
function commandName(path, dir) {
  const base = stripTilde(dir).replace(/\/+$/, "");
  const rel = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path.replace(/^.*\//, "");
  return rel.replace(/\.md$/i, "");
}

// The `description:` frontmatter key, else the first line of prose. Only the
// one key is read: a command file's body is a prompt template, and parsing it
// any further would be inventing meaning the menu has no use for.
function describe(text) {
  const normalized = (text || "").replace(/\r\n/g, "\n");
  const front = normalized.match(/^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/);
  if (front) {
    const match = front[1].match(/^description:[ \t]*(.*)$/m);
    if (match) return unquote(match[1]);
  }
  const body = front ? normalized.slice(front[0].length) : normalized;
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return line ? line.slice(0, 120) : "";
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

const loadCache = () => readJSON(CACHE_KEY, {}) || {};

// Read every command file in both scopes for the session's project. One PTY
// round-trip covers the lot (readMarkdownDirs), and the answer is cached under
// the project directory so a reload has something to show immediately.
export async function loadLocalCommands() {
  const projectDirectory = activeSessionDirectory() || "";
  const cacheKey = projectDirectory || "~";

  // Show the cached list while the read is in flight rather than emptying the
  // menu — a slow PTY shouldn't make commands appear to vanish.
  const cached = loadCache()[cacheKey];
  if (cached && Array.isArray(cached.commands)) localCommandsStore.commands = cached.commands;

  if (localCommandsStore.loading) return;
  localCommandsStore.loading = true;
  localCommandsStore.error = "";

  // PTY commands need a working directory; the project's own is the natural
  // one, and "/" stands in when no session is open (the global scope is
  // addressed through $HOME, not the cwd).
  const cwd = projectDirectory || "/";
  const dirs = scopeDirs(projectDirectory);

  try {
    const files = await readMarkdownDirs(cwd, dirs.map((d) => d.dir), { recursive: true });
    // Project beats global on a name collision, which is the precedence
    // opencode itself applies — so walk global first and let project overwrite.
    const byName = new Map();
    for (const scope of ["global", "project"]) {
      for (const file of files) {
        if (file.error) continue;
        const owner = dirs.find(
          (d) => d.scope === scope && file.path.startsWith(`${stripTilde(d.dir).replace(/\/+$/, "")}/`)
        );
        if (!owner) continue;
        const name = commandName(file.path, owner.dir);
        if (!name) continue;
        byName.set(name, {
          name,
          description: describe(file.text),
          path: file.path,
          scope,
        });
      }
    }

    const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    localCommandsStore.commands = commands;

    const cache = loadCache();
    cache[cacheKey] = { commands, fetchedAt: Date.now() };
    writeJSON(CACHE_KEY, cache);
  } catch (e) {
    // The cached list (if any) stays on screen: a PTY that couldn't be reached
    // says nothing about whether the files are still there.
    localCommandsStore.error = e.message || "could not read command files";
    throw e;
  } finally {
    localCommandsStore.loading = false;
  }
}

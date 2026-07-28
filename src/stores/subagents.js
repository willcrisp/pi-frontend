// Sub-agent definitions: list, create, edit and delete the markdown files that
// define the agents the `subagent` tool can dispatch.
//
// Why files. The V2 HTTP API exposes agents read-only — `GET /api/agent` and
// nothing else. There is no agent CRUD route and no `/api/config` route in the
// V2 surface, so the only place a sub-agent can be *defined* is on disk, in the
// format opencode's own config loader reads:
//
//   project:  <session directory>/.opencode/agent/<name>.md   (or agents/)
//   global:   ~/.config/opencode/agent/<name>.md              (or agents/)
//
//   ---
//   description: Reviews PRs for style violations.
//   mode: subagent
//   model: anthropic/claude-sonnet-4-6
//   variant: high
//   ---
//   You are a strict PR reviewer…
//
// The file body is the agent's prompt (never a `prompt:` key in the
// frontmatter). Allowed frontmatter keys are exactly: name, model, variant,
// description, mode, hidden, color, steps, options, permission, disable,
// temperature, top_p — any other key is silently swallowed into `options`.
// `model` is a `providerID/modelID` string and `variant` is the reasoning-effort
// preset, matching the `variants` the model catalog reports.
//
// ⚠️ opencode reads config once at startup and does NOT hot-reload it. A file
// written here does not become a live agent until the server restarts, which is
// why every definition carries a `status` telling the two apart.
import { reactive } from "vue";
import { loadAgents, opencodeStore } from "./opencode.js";
import { activeSessionDirectory } from "./projects.js";
import { readMarkdownDirs, removeFile, writeTextFile } from "./remotefs.js";

export const subagentsStore = reactive({
  // File-backed definitions across both scopes, subagent-mode only.
  // [{ id, path, scope, description, model, variant, temperature, tools,
  //    prompt, entries, raw, parseError }]
  defs: [],
  loading: false,
  saving: false,
  error: "",
  // Sticky reminder after a write — the server won't pick the change up until
  // it restarts, and nothing else in the UI would say so.
  notice: "",
});

// opencode accepts both the singular and plural directory name in each scope,
// so both are listed; new files always go to the singular (canonical) one.
export const PROJECT_DIR = ".opencode/agent";
export const GLOBAL_DIR = "~/.config/opencode/agent";

function scopeDirs(projectDirectory) {
  const dirs = [];
  if (projectDirectory) {
    const root = projectDirectory.replace(/\/+$/, "");
    dirs.push(
      { scope: "project", dir: `${root}/.opencode/agent` },
      { scope: "project", dir: `${root}/.opencode/agents` }
    );
  }
  dirs.push({ scope: "global", dir: GLOBAL_DIR }, { scope: "global", dir: "~/.config/opencode/agents" });
  return dirs;
}

// Canonical directory a newly saved definition is written to.
export function writeDirFor(scope, projectDirectory) {
  if (scope === "project") {
    const root = (projectDirectory || "").replace(/\/+$/, "");
    return root ? `${root}/${PROJECT_DIR}` : "";
  }
  return GLOBAL_DIR;
}

// --- Frontmatter codec -------------------------------------------------------
// A deliberately small YAML subset: `key: scalar` lines, plus nested blocks
// (`key:` followed by indented lines) kept verbatim so an unmanaged field like
// `permission:` survives a round-trip untouched. Anything outside that subset
// (a top-level list, a multi-line scalar) is a parse error, and the dialog
// falls back to editing the file as raw text rather than rewriting it wrongly.

const SCALAR_RE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;

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

function quoteScalar(value) {
  const v = String(value);
  // Left bare wherever YAML can't misread it — a quoted sentence is correct but
  // makes these files look machine-written next to hand-edited ones. Bars: an
  // indicator character in first position, a `: ` or ` #` that would re-parse as
  // structure, a trailing colon, or any newline / edge whitespace.
  const bare =
    v !== "" &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/: |\s#|\n/.test(v) &&
    !/:$/.test(v) &&
    v === v.trim();
  if (bare) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Split "---\n…\n---\n<body>" into frontmatter entries and body.
export function parseAgentFile(text) {
  const normalized = (text || "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n([\s\S]*))?$/);
  if (!match) {
    return { entries: [], body: normalized, error: "no --- frontmatter block" };
  }

  const lines = match[1].split("\n");
  const body = match[2] || "";
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      entries.push({ kind: "verbatim", raw: line });
      continue;
    }
    const m = line.match(SCALAR_RE);
    if (!m) {
      return { entries: [], body: normalized, error: `unsupported frontmatter line: ${line.trim()}` };
    }
    const [, key, rest] = m;
    if (rest.trim() === "") {
      // A nested block: this key's value is the indented lines that follow.
      const raw = [line];
      while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        raw.push(lines[++i]);
      }
      entries.push({ kind: "block", key, raw: raw.join("\n") });
      continue;
    }
    entries.push({ kind: "scalar", key, value: unquote(rest) });
  }

  return { entries, body, error: "" };
}

function entryValue(entries, key) {
  const found = entries.find((e) => e.kind === "scalar" && e.key === key);
  return found ? found.value : "";
}

// `tools` is a map of tool name -> allowed. It shows up either inline
// (`tools: { write: false }`) or as a nested block; both are read here, and it
// is always written back as a block.
function parseTools(entries) {
  const inline = entries.find((e) => e.kind === "scalar" && e.key === "tools");
  if (inline) {
    const body = inline.value.replace(/^\{/, "").replace(/\}$/, "");
    const map = {};
    for (const pair of body.split(",")) {
      if (!pair.trim()) continue;
      const [k, v] = pair.split(":");
      if (!k || v === undefined) return null;
      map[unquote(k)] = unquote(v) === "true";
    }
    return map;
  }
  const block = entries.find((e) => e.kind === "block" && e.key === "tools");
  if (!block) return {};
  const map = {};
  for (const line of block.raw.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const m = line.trim().match(SCALAR_RE);
    if (!m || !/^(true|false)$/.test(unquote(m[2]))) return null; // not our shape — leave it alone
    map[m[1]] = unquote(m[2]) === "true";
  }
  return map;
}

// Rebuild a file from a definition, preserving every frontmatter key this
// editor doesn't manage (in its original position).
export function serializeAgentFile(def) {
  const managed = {
    description: def.description ? def.description.replace(/\s*\n\s*/g, " ").trim() : "",
    mode: "subagent",
    model: def.model || "",
    variant: def.model && def.variant ? def.variant : "",
    temperature: def.temperature === "" || def.temperature == null ? "" : String(def.temperature),
  };
  const toolsMap = def.tools && Object.keys(def.tools).length ? def.tools : null;

  const out = [];
  const written = new Set();

  const emitManaged = (key) => {
    written.add(key);
    if (managed[key]) out.push(`${key}: ${quoteScalar(managed[key])}`);
  };
  const emitTools = () => {
    written.add("tools");
    if (!toolsMap) return;
    out.push("tools:");
    for (const [name, allowed] of Object.entries(toolsMap)) out.push(`  ${name}: ${allowed}`);
  };

  for (const entry of def.entries || []) {
    if (entry.kind === "verbatim") {
      out.push(entry.raw);
      continue;
    }
    if (entry.key === "tools") {
      emitTools();
      continue;
    }
    if (entry.key in managed) {
      emitManaged(entry.key);
      continue;
    }
    // Never carry a `prompt:` key: the body is the prompt, and having both is
    // what the config loader tells you not to do.
    if (entry.key === "prompt") continue;
    out.push(entry.kind === "block" ? entry.raw : `${entry.key}: ${quoteScalar(entry.value)}`);
  }

  for (const key of ["description", "mode", "model", "variant", "temperature"]) {
    if (!written.has(key)) emitManaged(key);
  }
  if (!written.has("tools")) emitTools();

  const body = (def.prompt || "").replace(/\s+$/, "");
  return `---\n${out.join("\n")}\n---\n${body ? `\n${body}\n` : ""}`;
}

// --- Loading -----------------------------------------------------------------

function defFromFile(file, scope) {
  const id = file.path.replace(/^.*\//, "").replace(/\.md$/i, "");
  const base = { id, path: file.path, scope, raw: file.text };
  if (file.error) return { ...base, parseError: file.error };

  const { entries, body, error } = parseAgentFile(file.text);
  if (error) return { ...base, parseError: error };

  const tools = parseTools(entries);
  if (tools === null) {
    return { ...base, parseError: "tools: is not a simple name/boolean map" };
  }

  const temperature = entryValue(entries, "temperature");
  return {
    ...base,
    parseError: "",
    entries,
    mode: entryValue(entries, "mode") || "primary", // opencode's default when unset
    description: entryValue(entries, "description"),
    model: entryValue(entries, "model"),
    variant: entryValue(entries, "variant"),
    temperature,
    tools,
    prompt: body.replace(/^\n+/, "").replace(/\s+$/, ""),
  };
}

// Read every definition file in both scopes. Only sub-agents are kept — this
// dialog manages nothing else, and a primary agent editable here would be a
// footgun (it can be selected for a whole session from the composer).
export async function loadSubagents() {
  subagentsStore.loading = true;
  subagentsStore.error = "";
  const projectDirectory = activeSessionDirectory();
  // PTY commands need a working directory; the project's own is the natural
  // one, and "/" is a safe stand-in when no session is open (the global scope
  // is addressed through $HOME, not through the cwd).
  const cwd = projectDirectory || "/";

  try {
    const dirs = scopeDirs(projectDirectory);
    const files = await readMarkdownDirs(cwd, dirs.map((d) => d.dir));
    const defs = [];
    for (const file of files) {
      const owner = dirs.find((d) => file.path.startsWith(stripTilde(d.dir) + "/"));
      const def = defFromFile(file, owner ? owner.scope : "global");
      // A file that failed to parse stays in the list: it may well be the
      // sub-agent the user came here to fix, and hiding it would be worse.
      if (def.parseError || def.mode === "subagent") defs.push(def);
    }
    defs.sort((a, b) => a.id.localeCompare(b.id));
    subagentsStore.defs = defs;
  } catch (e) {
    subagentsStore.error = e.message || "failed to read sub-agent definitions";
  } finally {
    subagentsStore.loading = false;
  }
}

// `ls` prints the expanded path, so a `~`-rooted directory comes back as an
// absolute one; compare on the part after the tilde.
function stripTilde(dir) {
  return dir.startsWith("~/") ? dir.slice(1) : dir;
}

// --- Mutations ---------------------------------------------------------------

// Where a save lands. An edit that keeps its name and scope rewrites the file
// it came from — including one in the plural `agents/` directory, which is
// equally valid and shouldn't be silently relocated. Anything else (a new
// agent, a rename, a scope change) goes to the canonical directory.
export function saveTargetPath(draft, projectDirectory) {
  if (draft.originalPath && draft.originalScope === draft.scope) {
    const currentID = draft.originalPath.replace(/^.*\//, "").replace(/\.md$/i, "");
    if (currentID === draft.id) return draft.originalPath;
  }
  const dir = writeDirFor(draft.scope, projectDirectory);
  return dir ? `${dir}/${draft.id}.md` : "";
}

// Write a definition. `draft` carries the editor's fields plus `originalPath`
// (absent for a new agent); a rename or a scope change writes the new file and
// removes the old one.
export async function saveSubagent(draft) {
  subagentsStore.saving = true;
  subagentsStore.error = "";
  const projectDirectory = activeSessionDirectory();
  const cwd = projectDirectory || "/";

  try {
    const path = saveTargetPath(draft, projectDirectory);
    if (!path) throw new Error("no project directory for this session — save to the global scope instead");
    const text = draft.raw != null ? draft.raw : serializeAgentFile(draft);

    await writeTextFile(cwd, path, text);
    if (draft.originalPath && draft.originalPath !== path) {
      await removeFile(cwd, draft.originalPath);
    }

    subagentsStore.notice = `Saved ${path}. opencode reads agent files at startup — restart the server to pick this up.`;
    await refresh();
    return true;
  } catch (e) {
    subagentsStore.error = e.message || "failed to save sub-agent";
    return false;
  } finally {
    subagentsStore.saving = false;
  }
}

export async function deleteSubagent(def) {
  subagentsStore.saving = true;
  subagentsStore.error = "";
  try {
    await removeFile(activeSessionDirectory() || "/", def.path);
    subagentsStore.notice = `Deleted ${def.path}. Restart the opencode server to drop it from the live roster.`;
    await refresh();
    return true;
  } catch (e) {
    subagentsStore.error = e.message || "failed to delete sub-agent";
    return false;
  } finally {
    subagentsStore.saving = false;
  }
}

// Re-read the files and the live roster together: which definitions the server
// has actually loaded is half of what the list shows.
async function refresh() {
  await Promise.all([loadSubagents(), loadAgents()]);
}

// --- Live roster join --------------------------------------------------------

export function rosterEntry(id) {
  return opencodeStore.subagentRoster.find((a) => (a.id || a.name) === id) || null;
}

// "active"  — a file this server has loaded
// "pending" — a file written since the server started; needs a restart
export function defStatus(def) {
  return rosterEntry(def.id) ? "active" : "pending";
}

// Loaded sub-agents with no definition file in either scope: opencode's
// built-ins (`general`, `explore`). They're editable too — saving one writes a
// same-named file, which overrides the built-in's fields.
export function builtInSubagents() {
  const defined = new Set(subagentsStore.defs.map((d) => d.id));
  return opencodeStore.subagentRoster.filter((a) => !defined.has(a.id || a.name));
}

// A model catalog entry as the `providerID/modelID` string the config wants.
export function modelString(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  const id = model.modelID || model.id;
  return model.providerID && id ? `${model.providerID}/${id}` : "";
}

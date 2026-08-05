// Read/write/delete text files on the OpenCode host, over the PTY runner.
//
// The V2 HTTP API can read a file (`GET /api/fs/read/*`) but has no write route
// at all — and no config route either — so anything that has to *create* a file
// on the server (today: sub-agent definitions, see subagents.js) goes through a
// shell. `pty.js#runScript` is that shell; this module is the file-shaped
// wrapper around it.
//
// Everything moves as base64, in both directions. A PTY is a terminal, not a
// pipe: raw file bytes on the way out would be mangled by escape-sequence
// stripping and CR translation, and raw content on the way in would need shell
// quoting that survives newlines and quotes. Base64 is inert on both counts.
import { runScript, shellQuote } from "./pty.js";

// Longest base64 payload per input line. The PTY is in canonical mode, whose
// per-line limit (MAX_CANON) is typically 4096 bytes — stay well under it.
const CHUNK = 800;

const MISSING = "__OC_MISSING__";
const OK = "__OC_OK__";
const FILE_MARK = "__OC_FILE__";
// Payloads are fenced rather than read to end-of-output: the shell's own stderr
// (a missing `base64`, a permissions complaint) shares the stream, and stripping
// non-base64 characters from it would otherwise turn an error message into
// plausible-looking file content.
const B64_OPEN = "__OC_B64__";
const B64_CLOSE = "__OC_EOB__";

// A shell word for `path`, expanding a leading `~/` to $HOME (which the server
// side owns — the browser has no idea what the home directory is). Everything
// after the tilde stays single-quoted, so spaces and metacharacters are safe.
export function quotePath(path) {
  if (path === "~") return `"$HOME"`;
  if (path.startsWith("~/")) return `"$HOME"${shellQuote(path.slice(1))}`;
  return shellQuote(path);
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// The base64 payload between the fences, or null when there isn't a complete
// pair. Whitespace inside is dropped — the shell may wrap long lines.
function fencedB64(text, from = 0) {
  const start = text.indexOf(B64_OPEN, from);
  if (start === -1) return null;
  const end = text.indexOf(B64_CLOSE, start);
  if (end === -1) return null;
  return text.slice(start + B64_OPEN.length, end).replace(/\s+/g, "");
}

function decode(b64, path) {
  if (!b64) return "";
  if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
    throw new Error(`unexpected output reading ${path}`);
  }
  try {
    return fromBase64(b64);
  } catch {
    throw new Error(`could not decode ${path}`);
  }
}

// Emit `path`'s contents as a fenced base64 payload.
function dumpCommand(pathExpr) {
  return `printf '__OC%sB64__' _; base64 < ${pathExpr} | tr -d '\\n'; printf '__OC%sEOB__' _`;
}

// Contents of `path`, or null when it doesn't exist.
export async function readTextFile(cwd, path) {
  const p = quotePath(path);
  const out = await runScript(
    cwd,
    `if [ -f ${p} ]; then ${dumpCommand(p)}; else printf '__OC%sMISSING__' _; fi`,
    { title: `harness: read ${path}` }
  );
  if (out.includes(MISSING)) return null;
  const b64 = fencedB64(out);
  if (b64 === null) throw new Error(`could not read ${path}: ${firstErrorLine(out) || "no output"}`);
  return decode(b64, path);
}

// Every `*.md` under each of `dirs`, as { path, text }. Directories that don't
// exist contribute nothing. One PTY round-trip for the whole set — a per-file
// read costs a create/connect/teardown each and adds up fast.
export async function readMarkdownDirs(cwd, dirs, { recursive = false } = {}) {
  if (!dirs.length) return [];
  const globs = recursive
    ? dirs.map((d) => `find ${quotePath(d)} -type f -name '*.md' -print`).join("; ")
    : `printf '%s\\n' ${dirs.map((d) => `${quotePath(`${d}/`)}*.md`).join(" ")}`;
  const script = `for f in $(${globs}); do\n` +
    `[ -f "$f" ] || continue\n` +
    `printf '\\n__OC%sFILE__%s__\\n' _ "$f"\n` +
    `${dumpCommand('"$f"')}\n` +
    `done`;
  const out = await runScript(cwd, script, { title: "harness: read agent files" });

  const files = [];
  // Split on the per-file header. `split` with one capture group yields
  // [preamble, path, payload, path, payload, …].
  const parts = out.split(new RegExp(`${FILE_MARK}(.+?)__\\r?\\n`));
  for (let i = 1; i < parts.length; i += 2) {
    const path = parts[i].trim();
    if (!path) continue;
    const b64 = fencedB64(parts[i + 1] || "");
    if (b64 === null) {
      files.push({ path, text: "", error: "could not read file" });
      continue;
    }
    try {
      files.push({ path, text: decode(b64, path) });
    } catch (e) {
      files.push({ path, text: "", error: e.message });
    }
  }
  return files;
}

// Write `text` to `path`, creating parent directories. The payload is appended
// to a temp file in fixed-size chunks (one line each) and decoded in place, so
// no single input line can exceed the terminal's canonical-mode limit.
export async function writeTextFile(cwd, path, text) {
  const p = quotePath(path);
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const tmp = shellQuote(`/tmp/oc-write-${Math.random().toString(36).slice(2, 10)}.b64`);
  const b64 = toBase64(text);

  const lines = [`mkdir -p ${quotePath(dir)} || exit 1`, `: > ${tmp}`];
  for (let i = 0; i < b64.length; i += CHUNK) {
    lines.push(`printf %s ${shellQuote(b64.slice(i, i + CHUNK))} >> ${tmp}`);
  }
  lines.push(
    `if base64 -d < ${tmp} > ${p}; then printf '__OC%sOK__' _; fi`,
    `rm -f ${tmp}`
  );

  const out = await runScript(cwd, lines.join("\n"), {
    timeoutMs: 30000,
    title: `harness: write ${path}`,
  });
  if (!out.includes(OK)) {
    throw new Error(`failed to write ${path}${firstErrorLine(out) ? `: ${firstErrorLine(out)}` : ""}`);
  }
}

export async function removeFile(cwd, path) {
  const out = await runScript(cwd, `rm -f ${quotePath(path)} && printf '__OC%sOK__' _`, {
    title: `harness: rm ${path}`,
  });
  if (!out.includes(OK)) {
    throw new Error(`failed to delete ${path}${firstErrorLine(out) ? `: ${firstErrorLine(out)}` : ""}`);
  }
}

// The shell's complaint, for an error message the user can act on.
function firstErrorLine(out) {
  return (
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => !l.startsWith("__OC")) || ""
  );
}

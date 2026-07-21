// Line-based diff rendering support for edit/write tool calls (MessageView.vue).
// No dependency: a plain LCS over lines with a size guard, plus detection of
// "this tool call is a file edit" from the call's arguments. Detection is by
// argument shape rather than a fixed tool-name list so it keeps working across
// pi versions and custom edit-like tools.
//
// Key exports:
//   editDiffInfo(name, args) — detects an edit/write-shaped tool call, returns
//     { path, hunks: [{oldText, newText}, ...] } or null
//   lineDiff(oldText, newText) — LCS line diff -> [{type: "ctx"|"add"|"del", text}]
//   collapseRows(rows, ctx) — collapses long unchanged runs to `ctx` lines of
//     context per side, replacing the rest with {type: "skip", count}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "absolute_path"];
const OLD_KEYS = ["oldText", "old_text", "old_str", "old_string", "oldString"];
const NEW_KEYS = ["newText", "new_text", "new_str", "new_string", "newString"];
const CONTENT_KEYS = ["content", "text", "fileText", "file_text"];
const EDITS_KEYS = ["edits", "diffs", "changes", "replacements"];

function pickString(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === "string") return obj[k];
  }
  return null;
}

function pickArray(obj, keys) {
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return null;
}

function editPair(obj) {
  const oldText = pickString(obj, OLD_KEYS);
  const newText = pickString(obj, NEW_KEYS);
  return oldText !== null && newText !== null ? { oldText, newText } : null;
}

// Returns { path, hunks: [{ oldText, newText }, ...] } when the tool call
// looks like a file edit — a single old/new pair, an array of them (a
// multi-edit call against one file), or a whole-file write (content, all
// additions) — else null. Write-style calls additionally require an
// edit-ish tool name so that arbitrary tools with a `content` argument
// don't render as diffs.
export function editDiffInfo(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const path = pickString(args, PATH_KEYS);

  const single = editPair(args);
  if (single) return { path, hunks: [single] };

  const editsArr = pickArray(args, EDITS_KEYS);
  if (editsArr) {
    const hunks = editsArr
      .map((e) => (e && typeof e === "object" ? editPair(e) : null))
      .filter(Boolean);
    if (hunks.length) return { path, hunks };
  }

  if (/^(write|create)/i.test(name || "")) {
    const content = pickString(args, CONTENT_KEYS);
    if (content !== null && path) return { path, hunks: [{ oldText: "", newText: content }] };
  }
  return null;
}

// LCS line diff: returns [{ type: "ctx" | "add" | "del", text }] in order.
// Above the size guard the quadratic LCS table is too expensive, so fall back
// to the trivial (still correct, just noisier) all-del + all-add diff.
export function lineDiff(oldText, newText) {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");

  // Trim common prefix/suffix first — edits are usually local, and this keeps
  // the LCS table small even for big files.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows = a.slice(0, start).map((text) => ({ type: "ctx", text }));

  if (midA.length * midB.length > 250_000) {
    for (const text of midA) rows.push({ type: "del", text });
    for (const text of midB) rows.push({ type: "add", text });
  } else {
    // Standard LCS DP table, then walk back to emit del/add/ctx rows.
    const n = midA.length;
    const m = midB.length;
    const table = new Array((n + 1) * (m + 1)).fill(0);
    const at = (i, j) => i * (m + 1) + j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        table[at(i, j)] =
          midA[i - 1] === midB[j - 1]
            ? table[at(i - 1, j - 1)] + 1
            : Math.max(table[at(i - 1, j)], table[at(i, j - 1)]);
      }
    }
    const mid = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && midA[i - 1] === midB[j - 1]) {
        mid.push({ type: "ctx", text: midA[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || table[at(i, j - 1)] >= table[at(i - 1, j)])) {
        mid.push({ type: "add", text: midB[j - 1] });
        j--;
      } else {
        mid.push({ type: "del", text: midA[i - 1] });
        i--;
      }
    }
    mid.reverse();
    rows.push(...mid);
  }

  for (const text of a.slice(endA)) rows.push({ type: "ctx", text });
  return rows;
}

// Collapse long unchanged runs down to `ctx` lines of context around each
// change, replacing the hidden middle with { type: "skip", count } markers.
export function collapseRows(rows, ctx = 3) {
  const out = [];
  let run = [];

  const flush = (keepLeading, keepTrailing) => {
    const lead = keepLeading ? Math.min(ctx, run.length) : 0;
    const trail = keepTrailing ? Math.min(ctx, run.length - lead) : 0;
    const hidden = run.length - lead - trail;
    if (hidden > ctx) {
      out.push(...run.slice(0, lead));
      out.push({ type: "skip", count: hidden });
      if (trail) out.push(...run.slice(run.length - trail));
    } else {
      out.push(...run);
    }
    run = [];
  };

  let seenChange = false;
  for (const row of rows) {
    if (row.type === "ctx") {
      run.push(row);
    } else {
      if (run.length) flush(seenChange, true);
      out.push(row);
      seenChange = true;
    }
  }
  if (run.length) flush(seenChange, false);
  return out;
}

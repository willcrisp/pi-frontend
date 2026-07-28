// File preview. Tool calls constantly reference files by path (read, patch,
// grep…), and following one up meant leaving the app. GET /api/fs/read/*
// returns the contents, so a path in a tool call can open inline instead.
import { reactive } from "vue";
import { apiGet } from "../lib/api.js";
import { activeSessionDirectory } from "./projects.js";

export const previewStore = reactive({
  open: false,
  path: "", // as displayed — the path the tool call used
  content: "",
  loading: false,
  error: null,
});

// The server sandboxes reads to the session's project root and takes a
// RELATIVE path (the same rule that bites `fs/list` — see the gotchas in
// docs/opencode-api.md), but tool calls mostly carry absolute paths. Strip
// the session directory prefix when it's there.
function relativeTo(directory, path) {
  const p = String(path).replace(/\\/g, "/");
  if (!directory) return p.replace(/^\/+/, "");
  const dir = String(directory).replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === dir) return "";
  if (p.startsWith(`${dir}/`)) return p.slice(dir.length + 1);
  return p.replace(/^\/+/, "");
}

export async function openPreview(path) {
  if (!path) return;
  const directory = activeSessionDirectory();
  previewStore.open = true;
  previewStore.path = path;
  previewStore.content = "";
  previewStore.error = null;
  previewStore.loading = true;

  const params = new URLSearchParams();
  if (directory) params.set("location[directory]", directory);
  const rel = relativeTo(directory, path);
  const path_ = `/fs/read/${rel.split("/").map(encodeURIComponent).join("/")}${
    params.toString() ? `?${params}` : ""
  }`;

  try {
    const res = await apiGet(path_);
    if (!res.ok) {
      previewStore.error = `Could not read file (${res.status})`;
      return;
    }
    const text = await res.text();
    // The route may answer with the raw file or with a JSON envelope around
    // it; prefer the envelope's content field when the body parses as one.
    previewStore.content = unwrapContent(text);
  } catch (err) {
    previewStore.error = err.message || "Could not read file";
  } finally {
    previewStore.loading = false;
  }
}

function unwrapContent(text) {
  try {
    const parsed = JSON.parse(text);
    const d = parsed?.data ?? parsed;
    if (typeof d === "string") return d;
    if (d && typeof d.content === "string") return d.content;
    if (d && typeof d.text === "string") return d.text;
  } catch {
    /* not JSON — it's the file itself */
  }
  return text;
}

export function closePreview() {
  previewStore.open = false;
  previewStore.content = "";
  previewStore.error = null;
}

// The argument keys tool calls actually use for a file path. Anything else is
// treated as not-a-file rather than guessed at.
const PATH_KEYS = ["file_path", "filePath", "path", "filename"];

export function filePathFromToolInput(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

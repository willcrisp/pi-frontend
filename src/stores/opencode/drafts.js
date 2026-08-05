// Per-session composer drafts.
//
// A half-typed prompt belongs to the chat it was typed in, so switching away
// and back has to bring it with you — losing it was silent and unrecoverable.
// `opencodeStore.draft` is always the ACTIVE session's draft (the composer
// binds straight to it); this module holds the rest and persists the lot, so a
// reload doesn't drop work in progress either.
import { watch } from "vue";
import { opencodeStore } from "./state.js";
import { readJSON, writeJSON } from "../../lib/storage.js";

const DRAFTS_KEY = "oc.drafts"; // { [sessionID]: text }

// Typing shouldn't hit localStorage on every keystroke.
const SAVE_DEBOUNCE_MS = 400;

function allDrafts() {
  const map = readJSON(DRAFTS_KEY, {});
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

// Store one session's draft, dropping the entry entirely when it's empty so the
// map doesn't accumulate a key per session ever visited.
function persist(sessionID, text) {
  if (!sessionID) return;
  const map = allDrafts();
  const trimmed = (text || "").trim();
  if (trimmed) map[sessionID] = text;
  else if (!(sessionID in map)) return; // nothing stored, nothing to clear
  else delete map[sessionID];
  writeJSON(DRAFTS_KEY, map);
}

function loadDraft(sessionID) {
  const stored = allDrafts()[sessionID];
  return typeof stored === "string" ? stored : "";
}

let timer = null;

// Flush any pending debounced write immediately. Called before a session
// switch, so the outgoing chat's draft is on disk before `draft` is overwritten.
function flushDraft() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  return true;
}

// Swap the active draft over to `sessionID`, filing the outgoing one first.
// Synchronous and called before any await in connectToSession, so `draft` is
// never briefly the previous chat's text while the new id is already active.
export function switchDraft(previousID, sessionID) {
  flushDraft();
  if (previousID && previousID !== sessionID) persist(previousID, opencodeStore.draft);
  opencodeStore.draft = loadDraft(sessionID);
}

// The session id is captured when the change happens rather than read at flush
// time: a switch during the debounce window must not file the old text under
// the new chat.
watch(
  () => opencodeStore.draft,
  (text) => {
    const sessionID = opencodeStore.activeSessionId;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist(sessionID, text);
    }, SAVE_DEBOUNCE_MS);
  }
);

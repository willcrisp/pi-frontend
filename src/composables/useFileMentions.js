// @-file mention autocomplete: sourced from the same recursive, cached file list
// the Ctrl/Cmd+K palette uses (stores/filesearch.js — PTY-based fdfind/fd/git
// ls-files, since GET /api/fs/list is single-level only).
//
// Unlike the slash menu (only ever "/query" from an empty box), a mention can
// start anywhere in the message, so it is tracked from the live caret position
// rather than derived straight from `input`.
//
// A chosen "@path" is inserted as plain text; the server has no in-text mention
// resolution in this build (confirmed inert for `@agent`, see
// docs/subagents-v2.md), so it is a typing convenience only — the agent reads
// the path with its own tools same as if the user had typed it by hand.
import { computed, nextTick, ref, watch } from "vue";
import { activeSessionDirectory } from "../stores/projects.js";
import { filesFor, refreshFiles } from "../stores/filesearch.js";
import { fuzzyScore } from "../lib/fuzzy.js";

const MAX_MATCHES = 20;

export function useFileMentions(input, textareaEl, autosize) {
  // { query, start, end } char offsets into the textarea value, or null.
  const query = ref(null);
  const index = ref(0);
  // The exact "@…" span Escape dismissed, or null. Needed because this runs on
  // keyup as well as input: without it, Escape's keydown clears the menu and the
  // keyup that follows immediately re-detects the same mention and reopens it.
  let dismissed = null;

  // Called from keyup/click as well as input, because the caret moves without
  // the text changing.
  function updateMentionState(el) {
    el = el || textareaEl.value;
    if (!el || el.selectionStart == null || el.selectionStart !== el.selectionEnd) {
      query.value = null;
      return;
    }
    const before = el.value.slice(0, el.selectionStart);
    // Preceded by start-of-text/whitespace/open-paren so "user@example.com" doesn't trigger.
    const m = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
    if (!m) {
      dismissed = null;
      query.value = null;
      return;
    }
    // Still sitting in the mention Escape closed — stay shut until the user
    // edits it or moves to a different one.
    if (dismissed && dismissed.start === el.selectionStart - m[1].length - 1 && dismissed.query === m[1]) {
      query.value = null;
      return;
    }
    dismissed = null;
    if (!query.value) {
      // Just opened: kick a background refresh, same as the palette on open —
      // the cached list (if any) shows immediately via filesFor below.
      const dir = activeSessionDirectory();
      if (dir) refreshFiles(dir);
    }
    query.value = {
      query: m[1],
      start: el.selectionStart - m[1].length - 1,
      end: el.selectionStart,
    };
  }

  const matches = computed(() => {
    const mq = query.value;
    if (!mq) return [];
    const dir = activeSessionDirectory();
    if (!dir) return [];
    const files = filesFor(dir).files;
    const q = mq.query.toLowerCase();
    if (!q) return files.slice(0, MAX_MATCHES);
    const scored = [];
    for (const f of files) {
      const score = fuzzyScore(q, f.toLowerCase());
      if (score !== null) scored.push({ f, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f)
      .slice(0, MAX_MATCHES);
  });

  const open = computed(() => !!query.value && matches.value.length > 0);

  watch(matches, () => {
    index.value = 0;
  });

  // Replace the "@query" span under the caret with "@path " and land the caret
  // right after it.
  function choose(path) {
    const mq = query.value;
    if (!path || !mq) return;
    const before = input.value.slice(0, mq.start);
    const after = input.value.slice(mq.end);
    const inserted = `@${path} `;
    input.value = before + inserted + after;
    query.value = null;
    nextTick(() => {
      const el = textareaEl.value;
      if (!el) return;
      el.focus();
      const cursor = before.length + inserted.length;
      el.setSelectionRange(cursor, cursor);
      autosize();
    });
  }

  // Escape dismisses only the menu — the typed text stays, since the mention is
  // part of a larger message.
  function escape(e) {
    e.preventDefault();
    if (query.value) dismissed = { start: query.value.start, query: query.value.query };
    query.value = null;
  }

  return { menu: { open, matches, index, choose, escape }, updateMentionState };
}

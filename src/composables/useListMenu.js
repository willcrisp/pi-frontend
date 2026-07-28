// Shared keyboard behaviour for the autocomplete menus that open above the
// composer (slash commands and @-file mentions).
//
// Both are the same widget — a list, a highlighted index, Enter/Tab to choose,
// Escape to dismiss — so they share this rather than each carrying its own copy
// of the arrow-key arithmetic. Only dismissal genuinely differs between them,
// which is why `escape` is per-menu.
//
// A menu object is `{ open, matches, index, choose, escape }`: three refs, and
// two functions.

// Handle one keydown against one open menu. Returns true when the menu consumed
// the key, in which case the caller must not act on it further.
export function listMenuKeydown(e, menu) {
  if (!menu.open.value) return false;

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = menu.matches.value.length;
    const step = e.key === "ArrowDown" ? 1 : -1;
    menu.index.value = (menu.index.value + step + n) % n;
    return true;
  }

  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    menu.choose(menu.matches.value[menu.index.value]);
    return true;
  }

  if (e.key === "Escape") {
    menu.escape(e);
    return true;
  }

  return false;
}

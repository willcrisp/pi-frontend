// The close contract every modal in this app is supposed to honour: Escape, a
// click on the backdrop, and the panel's own ✕.
//
// It exists because that contract was only two-thirds true. ShortcutsDialog
// advertises "Esc — Close the open menu or dialog", and Escape did close the
// palette, the shortcuts list, the question batch and the composer's menus — but
// not ProvidersDialog, SubagentsDialog, SavedPermissionsDialog or UsageDialog,
// which had a backdrop handler and no key listener at all. Two more
// (ConfirmDialog, HandoverDialog) put `@keydown.escape` on the backdrop <div>,
// which is not focusable: they worked only while something inside happened to
// hold focus, and went dead the moment the user clicked the backdrop.
//
// A listener on `window` has neither problem, and putting it here means a new
// dialog gets the behaviour by calling one function instead of remembering the
// rule.
//
//   const { onBackdrop } = useDialogEscape(() => emit("close"));
//
//   <div class="connect-backdrop" @mousedown="onBackdrop"> …
//
// `enabled` opts out per-dialog for a modal that must not be dismissible by a
// stray keypress — PermissionDialog uses it so a gating decision is never made
// by accident.
import { onBeforeUnmount, onMounted } from "vue";

// Only the topmost dialog should react, so a dialog opened from another dialog
// (the usage popover's "All usage & history", a sub-agent editor over its list)
// closes one layer per press rather than all of them at once.
const stack = [];

export function useDialogEscape(close, { enabled = true } = {}) {
  const entry = { close, enabled };

  function onKeydown(e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const top = stack[stack.length - 1];
    if (top !== entry || !entry.enabled) return;
    // Claim the key so nothing further down — the composer's Escape-to-interrupt,
    // say — also acts on it.
    e.preventDefault();
    e.stopPropagation();
    entry.close();
  }

  onMounted(() => {
    stack.push(entry);
    window.addEventListener("keydown", onKeydown);
  });

  onBeforeUnmount(() => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    window.removeEventListener("keydown", onKeydown);
  });

  // Backdrop mousedown, ignoring presses that started inside the panel.
  function onBackdrop(e) {
    if (e.target === e.currentTarget) close();
  }

  return { onBackdrop };
}

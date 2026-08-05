// The close contract every dismissible surface in this app honours: Escape, a
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
//   const { onBackdrop } = useDialogEscape(() => emit("close"));
//
//   <div class="connect-backdrop" @mousedown="onBackdrop"> …
//
// ## Why one shared listener, and not one per caller
//
// The first version registered a `window` listener per dialog and let the
// topmost entry act. That was still wrong in two ways, and both had teeth:
//
//   · Half the surfaces never adopted it (CommandPalette, ShortcutsDialog,
//     ImageAnnotator, QuestionDialog, PermissionDialog, the popovers, FindBar,
//     FilePreview, SelectMenu all hand-rolled a listener) and none of those
//     checked `defaultPrevented`. A `permission.v2.asked` arriving over an open
//     dialog was rejected by the very same Escape that closed the dialog.
//
//   · Plain `window` listeners fire in registration — i.e. mount — order, so
//     when two did coordinate, the surface opened *first* won. Backwards.
//
// So there is now exactly one listener for every participant, and it consults
// the stack below. Two surfaces can no longer act on one press, because only one
// handler exists to do the acting.
//
// ## `open`, and why stack order is not mount order
//
// Most surfaces here are mounted for the life of the app and toggle a `v-if`'d
// panel (the palette owns Ctrl+K, so it has to be listening while closed). For
// those, mount order says nothing about which is on top — pass `open` and the
// entry is raised when it becomes true, so the stack is ordered by *when each
// surface opened*. A dialog that is mounted only while open (the `connect-*`
// ones, rendered under a `v-if` by their parent) can leave `open` alone: being
// mounted is the same statement.
//
// `open` takes a ref, a getter, or a plain boolean.
//
// ## For everything else that wants the key
//
// `escapeIsOwned()` answers "would a press be consumed by an open surface?".
// Composer.vue's Escape-to-interrupt is deliberately the lowest-priority claim
// on the key and asks this before acting. It used to guess by querying the DOM
// for a hand-maintained list of nine CSS selectors — every new dialog meant
// remembering to edit a list in an unrelated component, and its own comment
// recorded that getting one subtly wrong (`.select-menu` for `.select-panel`)
// had silently disabled the shortcut altogether. Registering here replaces it.
import { onBeforeUnmount, onMounted, toValue, watch } from "vue";

// Innermost surface last. Entries whose `open` is false are skipped rather than
// removed, so an always-mounted palette doesn't have to leave and re-enter.
const stack = [];
let listening = false;

function isOpen(entry) {
  return Boolean(entry.open());
}

// The surface a press belongs to: the topmost open one. A dialog opened from
// another dialog (the usage popover's "All usage & history", a sub-agent editor
// over its list) therefore closes one layer per press, not all of them.
function topmost() {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (isOpen(stack[i])) return stack[i];
  }
  return null;
}

// Whether an open surface would consume an Escape press.
export function escapeIsOwned() {
  return topmost() !== null;
}

function onKeydown(e) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const entry = topmost();
  if (!entry) return;
  // Claim the key. Nothing else in the app acts on Escape without checking
  // `defaultPrevented` or `escapeIsOwned()` first.
  e.preventDefault();
  entry.close();
}

function raise(entry) {
  const i = stack.indexOf(entry);
  if (i >= 0) stack.splice(i, 1);
  stack.push(entry);
}

export function useDialogEscape(close, { open = true } = {}) {
  const entry = { close, open: () => toValue(open) };
  // The stack is entered on mount and left on unmount, and `raise` must not run
  // outside that window: the watcher below is registered during setup and its
  // `pre` flush can fire before onMounted, which would push a second copy of an
  // entry that then only ever gets removed once.
  let mounted = false;

  onMounted(() => {
    mounted = true;
    stack.push(entry);
    if (!listening) {
      window.addEventListener("keydown", onKeydown);
      listening = true;
    }
  });

  onBeforeUnmount(() => {
    mounted = false;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length && listening) {
      window.removeEventListener("keydown", onKeydown);
      listening = false;
    }
  });

  // Opening raises to the top, so the stack reflects open order. A constant
  // `open` (the mounted-only-while-open case) never fires this and keeps its
  // mount position, which is already the right one.
  watch(
    () => entry.open(),
    (nowOpen) => {
      if (nowOpen && mounted) raise(entry);
    },
  );

  // Backdrop mousedown, ignoring presses that started inside the panel.
  function onBackdrop(e) {
    if (e.target === e.currentTarget) close();
  }

  return { onBackdrop };
}

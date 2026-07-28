// Open state for the keyboard shortcut reference (ShortcutsDialog.vue).
//
// A one-flag store rather than a ref inside the component, because the two
// things that open it sit in different parts of the tree: the dialog's own "?"
// hotkey, and the ? button in ChatHeader.
import { reactive } from "vue";

export const shortcutsStore = reactive({ open: false });

export function openShortcuts() {
  shortcutsStore.open = true;
}

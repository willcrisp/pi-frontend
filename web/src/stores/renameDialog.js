// Tiny reactive store for the session-rename dialog's open/closed state.
// Kept separate from pi.js's `store` (that's per-project chat state; this is
// pure UI state) and small enough not to warrant its own REST-backed module
// like auth.js/agents.js. Opened from both ChatHeader's rename button and
// Composer's /name slash command.
import { reactive } from "vue";

export const renameDialogStore = reactive({ open: false });

export function openRenameDialog() {
  renameDialogStore.open = true;
}

export function closeRenameDialog() {
  renameDialogStore.open = false;
}

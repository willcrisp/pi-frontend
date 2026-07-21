// Tiny reactive store for a custom confirm()/alert() replacement, same spirit
// as renameDialog.js (pure UI state, deliberately not part of pi.js's
// per-chat state). Two entry points:
//   - confirmDialog({ title, message, confirmLabel, cancelLabel, danger })
//     -> Promise<boolean>, resolves true on confirm, false on cancel/dismiss.
//   - alertDialog({ title, message }) -> Promise<void>, a single-button
//     variant (no cancel) for messages that just need acknowledging.
// Only one dialog is shown at a time: requesting a second while one is still
// open resolves the pending one as cancelled rather than losing the caller
// waiting on it. ConfirmDialog.vue renders confirmStore and calls
// resolveConfirm() in response to user action.
import { reactive } from "vue";

export const confirmStore = reactive({
  open: false,
  title: "",
  message: "",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
  danger: false,
  kind: "confirm", // "confirm" | "alert" — alert mode hides the cancel button
});

let resolveCurrent = null;

function open({ title, message, confirmLabel, cancelLabel, danger, kind }) {
  if (resolveCurrent) {
    // A prior dialog is still pending — don't strand its caller.
    resolveCurrent(false);
    resolveCurrent = null;
  }
  return new Promise((resolve) => {
    resolveCurrent = resolve;
    Object.assign(confirmStore, {
      open: true,
      title: title || "",
      message: message || "",
      confirmLabel: confirmLabel || (kind === "alert" ? "OK" : "Confirm"),
      cancelLabel: cancelLabel || "Cancel",
      danger: !!danger,
      kind: kind || "confirm",
    });
  });
}

export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger } = {}) {
  return open({ title, message, confirmLabel, cancelLabel, danger, kind: "confirm" });
}

export function alertDialog({ title, message } = {}) {
  return open({ title, message, kind: "alert" }).then(() => {});
}

export function resolveConfirm(result) {
  confirmStore.open = false;
  if (resolveCurrent) {
    resolveCurrent(result);
    resolveCurrent = null;
  }
}

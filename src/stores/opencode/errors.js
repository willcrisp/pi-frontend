// Reporting a failure that came from a turn: the POST that starts one, or the
// event that reports it dying.
//
// Everything else in the app writes `opencodeStore.error` directly and should
// keep doing so. This path is separate because only a turn's failure carries a
// *model provider's* complaint, and that is the one class of error worth
// explaining — see lib/autherror.js for what and why.
//
// The explanation is stored with the message it explains, and App.vue only
// prints it while the two still match. A store this shallow has no way to
// notice another writer replacing `error`, and a hint left sitting under an
// unrelated error would be worse than no hint at all.
import { opencodeStore } from "./state.js";
import { providerAuthHint } from "../../lib/autherror.js";

export function reportRunError(message) {
  const text = message || "The turn failed";
  const providerID = opencodeStore.selectedModel && opencodeStore.selectedModel.providerID;
  const hint = providerAuthHint(text, providerID);
  opencodeStore.error = text;
  opencodeStore.errorHint = hint ? { message: text, hint } : null;
}

// The hint for the error currently on screen, or null. Guards against the
// staleness above: a plain `opencodeStore.error = ...` elsewhere invalidates it.
export function errorHintFor(message) {
  const held = opencodeStore.errorHint;
  return held && held.message === message ? held.hint : null;
}

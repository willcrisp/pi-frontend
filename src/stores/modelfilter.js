// UI-only model filter state, shared between the header funnel popover
// (ModelFilterPopover.vue) and the composer's model picker: hidden models are
// dropped from the picker and persisted in localStorage.
import { ref } from "vue";
import { readArray, writeJSON } from "../lib/storage.js";

const HIDDEN_MODELS_KEY = "opencode-web:hiddenModels";

export const hiddenModels = ref(new Set(readArray(HIDDEN_MODELS_KEY)));

export function modelKey(m) {
  return `${m.providerID}:${m.modelID}`;
}

export function toggleModelHidden(m) {
  const next = new Set(hiddenModels.value);
  const key = modelKey(m);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hiddenModels.value = next;
  writeJSON(HIDDEN_MODELS_KEY, [...next]);
}

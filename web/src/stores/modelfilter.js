// UI-only model filter state, shared between the header funnel popover
// (ModelFilterPopover.vue) and the composer's model picker: hidden models are
// dropped from the picker and persisted in localStorage.
import { ref } from "vue";

const HIDDEN_MODELS_KEY = "opencode-web:hiddenModels";

function loadHiddenModels() {
  try {
    const list = JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY));
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

export const hiddenModels = ref(loadHiddenModels());

export function modelKey(m) {
  return `${m.providerID}:${m.modelID}`;
}

export function toggleModelHidden(m) {
  const next = new Set(hiddenModels.value);
  const key = modelKey(m);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hiddenModels.value = next;
  try {
    localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...next]));
  } catch {}
}

// Model and reasoning-effort selection, and the two layers of persistence
// behind it — both in localStorage:
//   MODEL_KEY         — last model+variant the user picked, used as the seed for
//                       new sessions and on a cold load before any session is
//                       opened.
//   SESSION_MODEL_KEY — { [sessionID]: { providerID, modelID, variant } }, so
//                       each chat keeps the model it was last used with.
//
// A "variant" is a reasoning-effort preset the model offers; catalog loading
// lives in catalog.js, this module only reads what it produced.
import { opencodeStore } from "./state.js";
import { apiPost, errorMessage } from "../../lib/api.js";
import { readJSON, writeJSON } from "../../lib/storage.js";

const MODEL_KEY = "oc.model";
const SESSION_MODEL_KEY = "oc.sessionModels";

// Reasoning effort defaults to "low" (no provider-default option in the UI);
// models that don't offer "low" fall back to their first variant.
const DEFAULT_VARIANT = "low";

function modelInfo(model) {
  if (!model) return null;
  return (
    opencodeStore.availableModels.find(
      (m) => m.providerID === model.providerID && m.modelID === model.modelID
    ) || null
  );
}

// The variant to use for `model`, preferring `preferred` when the model offers it.
export function resolveVariant(model, preferred) {
  const variants = modelInfo(model)?.variants || [];
  if (!variants.length) return "";
  if (preferred && variants.includes(preferred)) return preferred;
  if (variants.includes(DEFAULT_VARIANT)) return DEFAULT_VARIANT;
  return variants[0];
}

export function persistSelection() {
  const m = opencodeStore.selectedModel;
  if (!m) return;
  const entry = { providerID: m.providerID, modelID: m.modelID, variant: opencodeStore.thinkingLevel };
  writeJSON(MODEL_KEY, entry);

  const sessionID = opencodeStore.activeSessionId;
  if (sessionID) {
    const map = readJSON(SESSION_MODEL_KEY, {}) || {};
    map[sessionID] = entry;
    writeJSON(SESSION_MODEL_KEY, map);
  }
}

// Apply a stored { providerID, modelID, variant } entry if that model still
// exists in the catalog. Returns true when it was applied.
export function applyStoredSelection(entry) {
  if (!entry || !modelInfo(entry)) return false;
  opencodeStore.selectedModel = { providerID: entry.providerID, modelID: entry.modelID };
  opencodeStore.thinkingLevel = resolveVariant(entry, entry.variant);
  return true;
}

// The last model the user picked anywhere, for seeding a fresh catalog load.
export function lastUsedSelection() {
  return readJSON(MODEL_KEY, null);
}

// Restore the model this session was last used with (falling back to the
// global last-used model), without pushing it back to the server — the session
// already has it, and `session.model.selected` will correct us if not.
export function restoreSessionModel(sessionID) {
  if (!opencodeStore.availableModels.length) return;
  const map = readJSON(SESSION_MODEL_KEY, {}) || {};
  if (applyStoredSelection(map[sessionID])) return;
  applyStoredSelection(lastUsedSelection());
}

// Select the model. Stored as { providerID, modelID }; switched on the active session via
// POST /api/session/:id/model { model: { id, providerID, variant? } } (Model.Ref).
export async function setModel(model) {
  opencodeStore.selectedModel = model;
  // Carry the current effort across if the new model offers it, else fall back
  // to the default ("low").
  opencodeStore.thinkingLevel = resolveVariant(model, opencodeStore.thinkingLevel);
  persistSelection();
  await pushSessionModel();
}

// Select the reasoning-effort variant for the current model.
export async function setThinkingLevel(level) {
  opencodeStore.thinkingLevel = resolveVariant(opencodeStore.selectedModel, level);
  persistSelection();
  await pushSessionModel();
}

// Same contract as setAgent: a picker showing a model the server didn't accept
// means the next prompt runs on something other than what the composer says, so
// a refusal is reported rather than logged. The local selection is left as the
// user set it — it is also the persisted preference for the next session, and
// dropping it would lose their choice as well as the switch.
async function pushSessionModel() {
  const sessionID = opencodeStore.activeSessionId;
  const modelRef = selectedModelRef();
  if (!sessionID || !modelRef) return;
  try {
    const res = await apiPost(`/session/${sessionID}/model`, { model: modelRef });
    if (!res.ok) {
      opencodeStore.error = await errorMessage(res, `Couldn't switch model (${res.status})`);
    }
  } catch (e) {
    opencodeStore.error = e.message || "Couldn't switch model";
  }
}

// Build a Model.Ref from the current selection (for session creation / model switch).
export function selectedModelRef() {
  const m = opencodeStore.selectedModel;
  if (!m || !m.modelID || !m.providerID) return undefined;
  const ref = { id: m.modelID, providerID: m.providerID };
  if (opencodeStore.thinkingLevel) ref.variant = opencodeStore.thinkingLevel;
  return ref;
}

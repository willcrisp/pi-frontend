// TrueFoundry model discovery: normalization, grouping, and the OpenCode
// provider config we generate from a selection.
//
// Dependency-free and free of network/PTY concerns on purpose — every function
// here is a pure transform, so the shape traps below are testable without a
// gateway, a shell, or a running OpenCode. `stores/providers.js` owns the I/O.
//
// Two response shapes reach `normalizeModels`, because two endpoints answer
// "what models does this PAT have":
//
//   1. The documented OpenAI-compatible `/models`:
//      {object: "list", data: [{id, object, owned_by}]}
//   2. The Fortescue tenant's enabled-model endpoint, keyed twice — by broad
//      provider type, then by configured provider *account*:
//      {"openai": {"openai": [ {...model} ]},
//       "virtual-model": {"general-virtual-models": [...], "vm-ainchor-mcp": [...]}}
//
// The second level is the operationally meaningful one: a tenant can run
// several accounts under one provider type, and model IDs are scoped by
// account, so that is what the picker groups by.

// OpenCode addresses custom providers through the AI SDK's OpenAI-compatible
// adapter. Verified against the published opencode.json schema: the key is
// `provider` (singular), the adapter field is `npm`, and per-provider settings
// live under `options` — not `providers`/`package`/`settings`, which an earlier
// draft of this feature used and which OpenCode ignores silently.
export const TRUEFOUNDRY_PROVIDER_ID = "truefoundry";
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

// The gateway the two dialogs prefill, once the user has saved one. Read at
// build time from VITE_TRUEFOUNDRY_GATEWAY (a `.env` is enough) and otherwise
// empty — it used to be one deployment's hostname hardcoded as a `ref()` default
// in both ProvidersDialog and UsageDialog, which is fine for that deployment and
// wrong for a general harness. Empty means the field shows its placeholder and
// asks, which is the honest default for anyone else.
//
// The user's own saved value always wins: this is only the fallback for a fresh
// browser (see the TRUEFOUNDRY_GATEWAY_KEY reads in ProvidersDialog/UsageDialog).
export const DEFAULT_TRUEFOUNDRY_GATEWAY = import.meta.env.VITE_TRUEFOUNDRY_GATEWAY || "";

// One key, so the two dialogs can't drift onto different storage.
export const TRUEFOUNDRY_GATEWAY_KEY = "truefoundry.gateway";

// A model is usable in a chat UI if it can hold a conversation. The enabled
// endpoint also lists embeddings, image models and one-off custom endpoints
// (Sora), which would otherwise become model-picker entries that break on first
// prompt. Absent `types`, keep the model — the standard /models response
// carries no type at all and filtering it out would empty the list.
function isChatCapable(model) {
  const types = model && model.types;
  if (Array.isArray(types)) return types.includes("chat") || types.includes("responses");
  if (typeof types === "string") return types === "chat" || types === "responses";
  return true;
}

// TrueFoundry sends the fully-qualified `account/model` in `model_fqn`, and
// that — not the bare `name` — is what the gateway expects back as the model
// ID. Falling back to `id` last keeps the standard /models shape working.
function modelID(model) {
  return model.model_fqn || model.model_id || model.id || "";
}

function displayName(model) {
  return model.name || model.model_fqn || model.model_id || model.id || "";
}

// Flatten the Fortescue two-level object into rows, tagging each with the keys
// it was found under so `account`/`provider` can prefer them later.
function flattenProviderKeyed(payload) {
  const rows = [];
  for (const [provider, accounts] of Object.entries(payload)) {
    if (!accounts || typeof accounts !== "object") continue;
    for (const [account, models] of Object.entries(accounts)) {
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (model && typeof model === "object") {
          rows.push({ ...model, discoveryProvider: provider, discoveryAccount: account });
        }
      }
    }
  }
  return rows;
}

// Normalized models, deduplicated by fully-qualified ID and sorted by display
// name. Accepts either supported payload shape; anything else yields [].
export function normalizeModels(payload) {
  if (!payload || typeof payload !== "object") return [];

  const rows = Array.isArray(payload.data)
    ? payload.data.filter((m) => m && typeof m === "object")
    : flattenProviderKeyed(payload);

  const byID = new Map();
  for (const row of rows) {
    if (!isChatCapable(row)) continue;
    const id = modelID(row);
    if (!id || byID.has(id)) continue;
    byID.set(id, {
      id,
      name: displayName(row),
      account: row.provider_account_name || row.discoveryAccount || row.owned_by || "Other",
      provider: row.provider || row.discoveryProvider || row.owned_by || "",
    });
  }

  return [...byID.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Group by provider *account*. Grouping by the broad type instead would merge
// distinct configured accounts — `general-virtual-models` and `vm-ainchor-mcp`
// are both "virtual-model" — and make precise selection impossible.
export function groupByAccount(models) {
  const groups = new Map();
  for (const model of models) {
    const key = model.account || model.provider || "Other";
    if (!groups.has(key)) groups.set(key, { id: key, provider: model.provider, models: [] });
    groups.get(key).models.push(model);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// The `provider.truefoundry` block for opencode.json. `limit` is only emitted
// when a caller supplies one: the discovery endpoints carry no context/output
// limits, and inventing them would put a wrong number in front of the user via
// the context bar. Absent a limit OpenCode falls back to its own default.
export function buildProviderConfig(gateway, models) {
  const entries = {};
  for (const model of models) {
    const entry = { name: model.name || model.id };
    if (model.contextLimit || model.outputLimit) {
      entry.limit = {};
      if (model.contextLimit) entry.limit.context = model.contextLimit;
      if (model.outputLimit) entry.limit.output = model.outputLimit;
    }
    entries[model.id] = entry;
  }

  return {
    npm: OPENAI_COMPATIBLE_NPM,
    name: "TrueFoundry",
    options: { baseURL: gateway },
    models: entries,
  };
}

// Merge the generated block into an existing parsed opencode.json, preserving
// every unrelated key.
//
// The whole `provider.truefoundry` entry is replaced rather than merged,
// because a merge could not express a *removal*: deselecting a model has to
// drop it from `models`, and a deep merge would keep it forever. The cost is
// that hand-added headers or limits on this one provider are overwritten — a
// deliberate trade, since the UI is the thing that owns this entry.
export function mergeIntoConfig(existing, block) {
  const config = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};

  // A non-object `provider` (null from a hand-edit, or a stray array) would
  // throw on property assignment; replace it rather than crash the save.
  const providers =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...config.provider }
      : {};

  providers[TRUEFOUNDRY_PROVIDER_ID] = block;
  config.provider = providers;
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
  return config;
}

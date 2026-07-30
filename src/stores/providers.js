// Integration/credential management. In the V2 HttpApi, providers and their
// auth methods are exposed under GET /api/integration — a large list of
// ~150 entries, each with `methods` (key/env/oauth) and `connections[]`
// showing what's already configured. Adding an API key goes through
// POST /api/integration/{id}/connect/key. There is no list-of-credentials
// endpoint — connection status lives inline on each integration.
import { reactive } from "vue";
import { apiGet, apiPost, apiDelete, unwrap } from "../lib/api.js";
import { activeSessionDirectory } from "./projects.js";
import { readTextFile, writeTextFile } from "./remotefs.js";
import { runScript, shellQuote } from "./pty.js";
import { readJSON, writeJSON } from "../lib/storage.js";
import {
  TRUEFOUNDRY_PROVIDER_ID,
  buildProviderConfig,
  mergeIntoConfig,
  normalizeModels,
} from "../lib/truefoundry.js";

export const providersStore = reactive({
  integrations: [], // [{ id, name, methods, connections }]
  loading: false,
  error: null,
  // In-flight OAuth attempt, or null. Only one at a time — the flow needs the
  // user's full attention (leave the app, authorize, come back with a code),
  // and concurrent attempts would make it ambiguous which one a pasted code
  // belongs to.
  oauthAttempt: null, // { id, integrationID, url, userCode, instructions, busy }

  // TrueFoundry discovery/selection. Kept apart from `error` above so a failed
  // discovery doesn't blank the integrations list's own error, and vice versa.
  trueFoundry: {
    models: [], // normalized, from lib/truefoundry.js
    busy: false,
    error: null,
    notice: null,
    testing: false,
    testResult: null, // { ok, message }
  },
});

export async function loadIntegrations() {
  providersStore.loading = true;
  providersStore.error = null;
  try {
    const res = await apiGet("/integration");
    if (res.ok) {
      providersStore.integrations = unwrap(await res.json());
    } else {
      providersStore.error = `Failed to load integrations (${res.status})`;
    }
  } catch (err) {
    providersStore.error = err.message || "Failed to load integrations";
  } finally {
    providersStore.loading = false;
  }
}

// POST /api/integration/{id}/connect/key { key, label? } — attaches an API
// key to the integration. Server re-reads its provider table after this so
// the model list picks up the newly-available provider.
export async function connectKey(integrationID, key, label) {
  providersStore.error = null;
  try {
    const body = { key };
    if (label) body.label = label;
    const res = await apiPost(`/integration/${integrationID}/connect/key`, body);
    if (!res.ok) {
      providersStore.error = `Failed to add credential (${res.status})`;
      return false;
    }
    await loadIntegrations();
    return true;
  } catch (err) {
    providersStore.error = err.message || "Failed to add credential";
    return false;
  }
}

// --- OAuth -----------------------------------------------------------------
// Providers whose `methods[]` include `{type: "oauth"}` (Anthropic, the
// OpenAI ChatGPT account, OpenCode Zen) can't be connected with a pasted key.
// The flow is: start an attempt, send the user to the returned URL, then
// complete the attempt — optionally with a code the provider hands back.
//
// The attempt's response fields are read tolerantly: the spec names the
// route but not the payload, and providers differ over whether they return a
// redirect URL, a device code, or both.
function readAttempt(payload, integrationID) {
  const d = (payload && (payload.data || payload)) || {};
  const id = d.id || d.attemptID;
  if (!id) return null;
  return {
    id,
    integrationID,
    url: d.url || d.authorizationUrl || d.verificationUrl || d.verificationUri || "",
    userCode: d.userCode || d.user_code || d.code || "",
    instructions: d.instructions || d.message || "",
    busy: false,
  };
}

// POST /api/integration/{id}/connect/oauth
export async function startOAuth(integrationID) {
  providersStore.error = null;
  try {
    const res = await apiPost(`/integration/${integrationID}/connect/oauth`, {});
    if (!res.ok) {
      providersStore.error = `Failed to start OAuth (${res.status})`;
      return false;
    }
    const attempt = readAttempt(await res.json().catch(() => null), integrationID);
    if (!attempt) {
      providersStore.error = "OAuth started but the server returned no attempt id";
      return false;
    }
    providersStore.oauthAttempt = attempt;
    return true;
  } catch (err) {
    providersStore.error = err.message || "Failed to start OAuth";
    return false;
  }
}

// POST /api/integration/attempt/{attemptID}/complete
export async function completeOAuth(code) {
  const attempt = providersStore.oauthAttempt;
  if (!attempt || attempt.busy) return false;
  attempt.busy = true;
  providersStore.error = null;
  try {
    const res = await apiPost(`/integration/attempt/${attempt.id}/complete`, code ? { code } : {});
    if (!res.ok) {
      providersStore.error = `Failed to complete OAuth (${res.status})`;
      return false;
    }
    providersStore.oauthAttempt = null;
    await loadIntegrations();
    return true;
  } catch (err) {
    providersStore.error = err.message || "Failed to complete OAuth";
    return false;
  } finally {
    if (providersStore.oauthAttempt) providersStore.oauthAttempt.busy = false;
  }
}

// DELETE /api/integration/attempt/{attemptID} — abandon the attempt server-side
// so it doesn't sit open. The local attempt is cleared either way; a failed
// cancel shouldn't strand the dialog in a flow the user has walked away from.
export async function cancelOAuth() {
  const attempt = providersStore.oauthAttempt;
  providersStore.oauthAttempt = null;
  if (!attempt) return;
  try {
    await apiDelete(`/integration/attempt/${attempt.id}`);
  } catch {
    /* best-effort */
  }
}

// --- TrueFoundry ------------------------------------------------------------
// A TrueFoundry gateway is not an OpenCode integration: the server has no
// entry for it until a config file declares one, and config is read at startup.
// So this half of the dialog writes a provider block to the project's
// opencode.json and — once the server has picked it up — hands the PAT to the
// normal credential endpoint.
//
// Discovery runs on the OpenCode host over PTY + curl rather than from the
// browser. A tenant gateway need not send CORS headers, Radius has no backend
// of its own to proxy through, and the OpenCode host is already the trusted
// place we run shell commands. It also means discovery works identically for a
// remote server reached over a tunnel.
const TRUEFOUNDRY_CONFIG = ".opencode/opencode.json";
const TRUEFOUNDRY_CONFIG_JSONC = ".opencode/opencode.jsonc";
const STATUS_MARKER = "__OC_CURL_STATUS__";

// Discovered catalogues are cached per gateway, the same way git.js and
// filesearch.js cache their own PTY results: a round-trip is create → token →
// WebSocket → teardown, and re-running it every time the dialog opens is a
// visible stall for a list that changes rarely. Only the model inventory is
// cached — never the PAT.
const CACHE_KEY = "opencode-web:truefoundry-cache"; // { [gateway]: { models, fetchedAt } }

function tfState() {
  return providersStore.trueFoundry;
}

const loadCache = () => readJSON(CACHE_KEY, {}) || {};

// Last discovered catalogue for `gateway`, or [] when there isn't one. Restores
// the selection list on reopen without touching the network.
export function restoreTrueFoundryCache(gateway) {
  let key;
  try {
    key = gatewayURL(gateway);
  } catch {
    return [];
  }
  const entry = loadCache()[key];
  const models = (entry && entry.models) || [];
  if (models.length) providersStore.trueFoundry.models = models;
  return models;
}

function cacheModels(gateway, models) {
  const cache = loadCache();
  cache[gateway] = { models, fetchedAt: Date.now() };
  writeJSON(CACHE_KEY, cache);
}

// Normalize and validate a user-typed gateway URL. The trailing slash goes so
// endpoint paths append cleanly.
export function gatewayURL(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Gateway URL must use http or https");
  }
  return url.href.replace(/\/$/, "");
}

// GET `url` with the PAT, from the OpenCode host, and parse the body as JSON.
//
// The PAT reaches curl through a config file on **stdin**, never as an argv
// header: arguments are visible in the host's process list, and this way the
// token never appears in one. It is also never written to disk, never logged,
// and the PTY title below is fixed text.
async function gatewayJSON(cwd, url, pat, { method = "GET", body = null } = {}) {
  // The PAT is interpolated into a curl config, where a newline or a quote
  // would let the caller inject directives. Current TrueFoundry PATs are
  // JWT-like and fit this set comfortably.
  if (!/^[A-Za-z0-9._~-]+$/.test(pat)) {
    throw new Error("PAT contains invalid characters");
  }

  let curlConfig = `header = "Authorization: Bearer ${pat}"\nurl = "${url}"\n`;
  let dataFile = "";
  if (body != null) {
    // A JSON body goes via a temp file for the same reason as the PAT: keeping
    // it out of argv, and out of reach of shell quoting bugs.
    dataFile = `/tmp/oc-tf-${Math.random().toString(36).slice(2, 10)}.json`;
    curlConfig +=
      `header = "Content-Type: application/json"\n` +
      `request = "${method}"\n` +
      `data = "@${dataFile}"\n`;
  }

  const lines = [];
  if (dataFile) {
    lines.push(`printf %s ${shellQuote(JSON.stringify(body))} > ${shellQuote(dataFile)}`);
  }
  lines.push(
    `printf %s ${shellQuote(curlConfig)} | ` +
      `curl --silent --show-error --fail-with-body --max-time 30 --config -; ` +
      `printf '\\n${STATUS_MARKER}%s' "$?"`
  );
  if (dataFile) lines.push(`rm -f ${shellQuote(dataFile)}`);

  const out = await runScript(cwd, lines.join("\n"), {
    timeoutMs: 45000,
    title: "harness: TrueFoundry request",
  });

  // The status marker separates "curl failed" from "curl succeeded but the body
  // wasn't JSON" — the Fortescue gateway answers /models with its SPA's HTML at
  // HTTP 200, so a 200 alone proves nothing about the PAT or the route.
  const at = out.lastIndexOf(STATUS_MARKER);
  const status = at === -1 ? "" : out.slice(at + STATUS_MARKER.length).trim();
  const payload = (at === -1 ? out : out.slice(0, at)).trim();
  if (status !== "0") {
    throw new Error("TrueFoundry rejected the request");
  }
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("Gateway returned a non-JSON response");
  }
}

// Discover the models this PAT can reach, trying the documented endpoint first
// and the Fortescue tenant's enabled-model endpoint second.
export async function discoverTrueFoundry(gateway, pat) {
  const state = tfState();
  state.busy = true;
  state.error = null;
  state.notice = null;
  state.testResult = null;

  // Selections survive a rediscovery by id in the component; clearing the list
  // here would otherwise strand ids that no longer exist.
  const previous = state.models;
  state.models = [];

  try {
    if (!pat) throw new Error("Enter a TrueFoundry PAT");
    const base = gatewayURL(gateway);
    const cwd = activeSessionDirectory() || undefined;

    let models = [];
    // Standard OpenAI-compatible discovery.
    try {
      models = normalizeModels(await gatewayJSON(cwd, `${base}/models`, pat));
    } catch {
      models = [];
    }

    // Fortescue serves its SPA at /models, so an empty or failed result falls
    // through to the tenant API. `origin` because the tenant path is absolute,
    // not relative to a gateway sub-path.
    if (!models.length) {
      const origin = new URL(base).origin;
      models = normalizeModels(
        await gatewayJSON(cwd, `${origin}/api/svc/v1/llm-gateway/model/enabled`, pat)
      );
    }

    if (!models.length) throw new Error("No chat-capable models are enabled for this PAT");

    state.models = models;
    cacheModels(base, models);
    state.notice = `Found ${models.length} chat model${models.length === 1 ? "" : "s"}.`;
    return models;
  } catch (err) {
    state.models = previous;
    state.error = err.message || "Discovery failed";
    return null;
  } finally {
    state.busy = false;
  }
}

// One cheap completion through `modelID`, so "connected" means callable rather
// than merely listed. The enabled endpoint reports inventory: it does not prove
// the PAT can invoke a model, that the provider account is healthy, or that the
// chat route isn't intercepted the way /models is.
export async function testTrueFoundryModel(gateway, pat, modelID) {
  const state = tfState();
  state.testing = true;
  state.testResult = null;
  try {
    const base = gatewayURL(gateway);
    const cwd = activeSessionDirectory() || undefined;
    const payload = await gatewayJSON(cwd, `${base}/api/inference/openai/chat/completions`, pat, {
      method: "POST",
      body: {
        model: modelID,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
    });
    const ok = Boolean(payload && (payload.choices || payload.id));
    state.testResult = ok
      ? { ok: true, message: `${modelID} answered.` }
      : { ok: false, message: `${modelID} returned an unexpected response shape.` };
    return ok;
  } catch (err) {
    state.testResult = { ok: false, message: err.message || "Test failed" };
    return false;
  } finally {
    state.testing = false;
  }
}

// Write the selected models into the active project's opencode.json and, if the
// running server already knows the provider, hand it the PAT.
export async function configureTrueFoundry(gateway, pat, models) {
  const state = tfState();
  state.busy = true;
  state.error = null;
  state.notice = null;
  try {
    if (!models || !models.length) throw new Error("Select at least one model");
    const base = gatewayURL(gateway);
    const cwd = activeSessionDirectory();
    if (!cwd) throw new Error("Open a project before configuring TrueFoundry");

    // JSONC is refused rather than rewritten. `JSON.parse` can't read it, and
    // stripping comments with a regex corrupts strings that merely look like
    // comments — destroying a user's config to save them one manual edit.
    const jsonc = await readTextFile(cwd, TRUEFOUNDRY_CONFIG_JSONC);
    if (jsonc !== null) {
      throw new Error(
        `This project uses ${TRUEFOUNDRY_CONFIG_JSONC}; add the TrueFoundry provider there manually`
      );
    }

    const raw = await readTextFile(cwd, TRUEFOUNDRY_CONFIG);
    let existing = {};
    if (raw && raw.trim()) {
      try {
        existing = JSON.parse(raw);
      } catch {
        throw new Error(`${TRUEFOUNDRY_CONFIG} is not valid JSON`);
      }
    }

    const merged = mergeIntoConfig(existing, buildProviderConfig(base, models));
    await writeTextFile(cwd, TRUEFOUNDRY_CONFIG, `${JSON.stringify(merged, null, 2)}\n`);

    // The config carries no credential — only the provider shape. The PAT goes
    // to OpenCode's own credential store, which is the one place designed to
    // hold it. Until the server has loaded the provider there is nothing to
    // attach it to, hence the two notices.
    const loaded = providersStore.integrations.some((i) => i.id === TRUEFOUNDRY_PROVIDER_ID);
    const count = `${models.length} model${models.length === 1 ? "" : "s"}`;
    if (loaded && (await connectKey(TRUEFOUNDRY_PROVIDER_ID, pat, "TrueFoundry PAT"))) {
      state.notice = `Saved ${count} and the PAT. Restart OpenCode to refresh the model catalog.`;
    } else {
      state.notice = `Saved ${count} to ${TRUEFOUNDRY_CONFIG}. Restart OpenCode, then reconnect the PAT.`;
    }
    return true;
  } catch (err) {
    state.error = err.message || "Could not configure TrueFoundry";
    return false;
  } finally {
    state.busy = false;
  }
}

// DELETE /api/credential/{credentialID} — credential IDs come from the
// integration's `connections[]` entries.
export async function removeCredential(credentialID) {
  providersStore.error = null;
  try {
    const res = await apiDelete(`/credential/${credentialID}`);
    if (!res.ok) {
      providersStore.error = `Failed to remove credential (${res.status})`;
      return;
    }
    await loadIntegrations();
  } catch (err) {
    providersStore.error = err.message || "Failed to remove credential";
  }
}

// Integration/credential management. In the V2 HttpApi, providers and their
// auth methods are exposed under GET /api/integration — a large list of
// ~150 entries, each with `methods` (key/env/oauth) and `connections[]`
// showing what's already configured. Adding an API key goes through
// POST /api/integration/{id}/connect/key. There is no list-of-credentials
// endpoint — connection status lives inline on each integration.
import { reactive } from "vue";
import { apiBase, authHeaders } from "./ssh.js";

export const providersStore = reactive({
  integrations: [], // [{ id, name, methods, connections }]
  loading: false,
  error: null,
  // In-flight OAuth attempt, or null. Only one at a time — the flow needs the
  // user's full attention (leave the app, authorize, come back with a code),
  // and concurrent attempts would make it ambiguous which one a pasted code
  // belongs to.
  oauthAttempt: null, // { id, integrationID, url, userCode, instructions, busy }
});

function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

export async function loadIntegrations() {
  providersStore.loading = true;
  providersStore.error = null;
  try {
    const res = await fetch(`${apiBase()}/integration`, { headers: authHeaders() });
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
    const res = await fetch(`${apiBase()}/integration/${integrationID}/connect/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
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
    const res = await fetch(`${apiBase()}/integration/${integrationID}/connect/oauth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: "{}",
    });
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
    const res = await fetch(`${apiBase()}/integration/attempt/${attempt.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(code ? { code } : {}),
    });
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
    await fetch(`${apiBase()}/integration/attempt/${attempt.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {
    /* best-effort */
  }
}

// DELETE /api/credential/{credentialID} — credential IDs come from the
// integration's `connections[]` entries.
export async function removeCredential(credentialID) {
  providersStore.error = null;
  try {
    const res = await fetch(`${apiBase()}/credential/${credentialID}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      providersStore.error = `Failed to remove credential (${res.status})`;
      return;
    }
    await loadIntegrations();
  } catch (err) {
    providersStore.error = err.message || "Failed to remove credential";
  }
}

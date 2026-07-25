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

// Provider/credential management: lists connected-provider metadata and lets
// the user add/remove API-key credentials from the UI instead of only via
// the server's own config. All routes here are UNVERIFIED against /doc —
// see docs/opencode-api.md — so every handler catches errors into `error`
// and never throws to the caller (matches runCommand's shim style).
import { reactive } from "vue";
import { apiBase, authHeaders } from "./ssh.js";

export const providersStore = reactive({
  providers: [], // [{ id, name, ... }]
  credentials: [], // [{ id, providerID, ... }]
  loading: false,
  error: null,
});

function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

// UNVERIFIED against /doc — see docs/opencode-api.md
export async function loadProviders() {
  providersStore.loading = true;
  try {
    const res = await fetch(`${apiBase()}/provider`, { headers: authHeaders() });
    if (res.ok) {
      providersStore.providers = unwrap(await res.json());
      providersStore.error = null;
    } else {
      providersStore.error = `Failed to load providers (${res.status})`;
    }
  } catch (err) {
    providersStore.error = err.message || "Failed to load providers";
  } finally {
    providersStore.loading = false;
  }
}

// UNVERIFIED against /doc — see docs/opencode-api.md
export async function loadCredentials() {
  try {
    const res = await fetch(`${apiBase()}/credential`, { headers: authHeaders() });
    if (res.ok) {
      providersStore.credentials = unwrap(await res.json());
      providersStore.error = null;
    } else {
      providersStore.error = `Failed to load credentials (${res.status})`;
    }
  } catch (err) {
    providersStore.error = err.message || "Failed to load credentials";
  }
}

// UNVERIFIED against /doc — see docs/opencode-api.md
export async function addCredential(providerID, apiKey) {
  try {
    const res = await fetch(`${apiBase()}/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ providerID, apiKey }),
    });
    if (!res.ok) {
      providersStore.error = `Failed to add credential (${res.status})`;
      return;
    }
    providersStore.error = null;
    await Promise.all([loadProviders(), loadCredentials()]);
  } catch (err) {
    providersStore.error = err.message || "Failed to add credential";
  }
}

export async function removeCredential(id) {
  try {
    const res = await fetch(`${apiBase()}/credential/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      providersStore.error = `Failed to remove credential (${res.status})`;
      return;
    }
    providersStore.error = null;
    await Promise.all([loadProviders(), loadCredentials()]);
  } catch (err) {
    providersStore.error = err.message || "Failed to remove credential";
  }
}

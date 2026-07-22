// REST client + reactive store for the global rtk toggle (see /api/rtk in
// server/src/main.rs). rtk (https://github.com/rtk-ai/rtk) compresses dev
// command output to save agent tokens via a pi extension; this is one
// global on/off switch, same conventions as ssh.js.
//
// Key exports:
//   rtkStore              — {enabled, available, version, extensionInstalled, probeError, loaded, saving, error}
//   fetchRtkStatus()       — GET /api/rtk, populates the store
//   setRtkEnabled(enabled) — PUT /api/rtk; applies the returned status on success,
//                            stores the error string and rethrows on failure
import { reactive } from "vue";

export const rtkStore = reactive({
  enabled: false,
  available: false,
  version: null,
  extensionInstalled: false,
  // Why `available`/`extensionInstalled` came back negative (an SSH
  // connect/auth failure, a timeout, a non-zero exit's stderr) — set by the
  // server when known, so "not installed" and "pi host unreachable" don't
  // look identical. Null when both probes are clean.
  probeError: null,
  loaded: false,
  saving: false,
  error: "",
});

function applyStatus(status) {
  rtkStore.enabled = !!status.enabled;
  rtkStore.available = !!status.available;
  rtkStore.version = status.version ?? null;
  rtkStore.extensionInstalled = !!status.extensionInstalled;
  rtkStore.probeError = status.probeError ?? null;
}

export async function fetchRtkStatus() {
  try {
    const res = await fetch("/api/rtk");
    if (!res.ok) return;
    applyStatus(await res.json());
    rtkStore.loaded = true;
  } catch {
    // Best-effort — the toggle just shows its last-known (or default) state.
  }
}

export async function setRtkEnabled(enabled) {
  rtkStore.saving = true;
  rtkStore.error = "";
  try {
    const res = await fetch("/api/rtk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const message = await res.text().catch(() => "");
      throw new Error(message || `failed to set rtk enabled (${res.status})`);
    }
    applyStatus(await res.json());
  } catch (e) {
    rtkStore.error = e.message || String(e);
    throw e;
  } finally {
    rtkStore.saving = false;
  }
}

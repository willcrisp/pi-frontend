// REST client + reactive store for the runtime-editable SSH target that
// every project's pi process is spawned against (see /api/ssh in
// server/src/main.rs). Mirrors the conventions in projects.js.
import { reactive } from "vue";

export const sshStore = reactive({
  host: null,
  identity: null,
  port: null,
  loaded: false,
  testing: false,
  testResult: null, // { ok, message, piFound } | null
  saving: false,
  clearing: false,
  error: "",
});

function applyConfig(cfg) {
  sshStore.host = cfg.host ?? null;
  sshStore.identity = cfg.identity ?? null;
  sshStore.port = cfg.port ?? null;
}

export async function fetchSshConfig() {
  const res = await fetch("/api/ssh");
  if (!res.ok) return;
  applyConfig(await res.json());
  sshStore.loaded = true;
}

export async function testSshConfig({ host, identity, port }) {
  sshStore.testing = true;
  sshStore.testResult = null;
  try {
    const res = await fetch("/api/ssh/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, identity: identity || null, port: port || null }),
    });
    const result = await res.json();
    sshStore.testResult = result;
    return result;
  } finally {
    sshStore.testing = false;
  }
}

export async function saveSshConfig({ host, identity, port }) {
  sshStore.saving = true;
  sshStore.error = "";
  try {
    const res = await fetch("/api/ssh", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, identity: identity || null, port: port || null }),
    });
    if (!res.ok) {
      const message = await res.text().catch(() => "");
      throw new Error(message || `failed to save ssh config (${res.status})`);
    }
    applyConfig(await res.json());
  } catch (e) {
    sshStore.error = e.message || String(e);
    throw e;
  } finally {
    sshStore.saving = false;
  }
}

export async function clearSshConfig() {
  sshStore.clearing = true;
  sshStore.error = "";
  try {
    const res = await fetch("/api/ssh", { method: "DELETE" });
    if (!res.ok) {
      throw new Error(`failed to clear ssh config (${res.status})`);
    }
    applyConfig(await res.json());
    sshStore.testResult = null;
  } catch (e) {
    sshStore.error = e.message || String(e);
    throw e;
  } finally {
    sshStore.clearing = false;
  }
}

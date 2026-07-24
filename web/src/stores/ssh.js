// OpenCode V2 SSH & Target Server Store
import { reactive } from "vue";

const TARGET_KEY = "opencode-web:serverTarget";

export const sshStore = reactive({
  targetUrl: localStorage.getItem(TARGET_KEY) || "http://127.0.0.1:4096",
  host: null,
  testing: false,
  testResult: null,
  error: "",
});

export async function testTargetUrl(url) {
  sshStore.testing = true;
  sshStore.testResult = null;
  sshStore.error = "";
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`);
    if (res.ok) {
      sshStore.testResult = { ok: true, message: "Connected to OpenCode V2 server!" };
      return true;
    } else {
      sshStore.testResult = { ok: false, message: `Server returned status ${res.status}` };
      return false;
    }
  } catch (err) {
    sshStore.testResult = { ok: false, message: err.message || "Failed to reach target server" };
    return false;
  } finally {
    sshStore.testing = false;
  }
}

export function setTargetUrl(url) {
  const cleanUrl = url.trim().replace(/\/$/, "");
  sshStore.targetUrl = cleanUrl;
  localStorage.setItem(TARGET_KEY, cleanUrl);
}

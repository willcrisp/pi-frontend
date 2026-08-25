<script setup>
// Where the phone is told which machine to talk to.
//
// This is the screen with no desktop equivalent worth reusing. On the desktop
// the server is always at 127.0.0.1 because an `ssh -L` tunnel put it there, so
// its connect dialog only asks for a port. A phone has no tunnel: it dials the
// host directly over the LAN or a Tailscale address, so the host is the field
// that matters and it comes first.
import { ref } from "vue";
import { connectionStore, setConnection, setCredentials, testConnection } from "../../stores/ssh.js";

const emit = defineEmits(["connected"]);

const host = ref(connectionStore.host === "127.0.0.1" ? "" : connectionStore.host);
const port = ref(String(connectionStore.port || 4096));
const password = ref(connectionStore.password || "");
const busy = ref(false);
const result = ref(null);

async function connect() {
  const h = host.value.trim();
  const p = Number(port.value) || 4096;
  if (!h) {
    result.value = { ok: false, message: "Enter the address of the machine running opencode2." };
    return;
  }
  busy.value = true;
  result.value = null;
  try {
    // Probe before committing: testConnection takes the typed values rather than
    // the stored ones precisely so a bad address doesn't replace a working one.
    const ok = await testConnection(p, "opencode", password.value, h);
    result.value = connectionStore.testResult;
    if (!ok) return;
    setConnection(p, "remote", h);
    setCredentials("opencode", password.value);
    emit("connected");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="connect">
    <header>
      <h1>radius</h1>
      <p>Connect to an OpenCode V2 server.</p>
    </header>

    <label>
      <span>Host</span>
      <!-- No autocapitalize/autocorrect: a phone keyboard will happily turn a
           hostname into "Alf-Uat.Coder" and the failure looks like a network
           problem. inputmode=url keeps the dot and dash on the primary row. -->
      <input
        v-model="host"
        type="text"
        inputmode="url"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        placeholder="100.x.y.z, or hostname.ts.net"
      />
    </label>

    <label>
      <span>Port</span>
      <input v-model="port" type="text" inputmode="numeric" placeholder="4096" />
    </label>

    <label>
      <span>Password</span>
      <input
        v-model="password"
        type="password"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        placeholder="opencode2 service password"
      />
    </label>

    <p v-if="result" class="result" :class="{ bad: !result.ok }">{{ result.message }}</p>

    <button class="primary" :disabled="busy" @click="connect">
      {{ busy ? "Connecting…" : "Connect" }}
    </button>

    <p class="hint">
      Run <code>opencode2 serve --hostname 0.0.0.0 --port 4096</code> on the machine, and
      <code>opencode2 service password</code> for the password. The phone needs a route to
      it — same Wi-Fi, or Tailscale.
    </p>
  </div>
</template>

<style scoped>
.connect {
  flex: 1;
  overflow-y: auto;
  padding: calc(env(safe-area-inset-top, 0px) + 48px) 22px
    calc(env(safe-area-inset-bottom, 0px) + 24px);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

header h1 {
  margin: 0 0 6px;
  font-size: 30px;
  letter-spacing: -0.02em;
}

header p {
  margin: 0;
  color: var(--fg-dim);
}

label {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

label span {
  font-size: 13px;
  color: var(--fg-dim);
}

input {
  /* 16px is not a style choice: below it, Android and iOS zoom the viewport on
     focus and never fully zoom back out. */
  font-size: 16px;
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--fg);
}

input:focus {
  outline: none;
  border-color: var(--accent);
}

.primary {
  margin-top: 4px;
  padding: 15px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 16px;
  font-weight: 600;
}

.primary:disabled {
  opacity: 0.55;
}

.result {
  margin: 0;
  font-size: 14px;
  color: var(--ok);
}

.result.bad {
  color: var(--bad);
}

.hint {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg-dim);
}

.hint code {
  font-size: 12px;
  padding: 2px 5px;
  border-radius: 5px;
  background: var(--bg-raised);
  word-break: break-all;
}
</style>

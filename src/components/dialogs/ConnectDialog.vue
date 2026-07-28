<!--
  ConnectScreen: full-screen boot gate shown until a reachable OpenCode V2
  server is found. Lets the user pick a Local (127.0.0.1:4096) or Remote
  (SSH-forwarded) target, test it, then connect.
-->
<script setup>
import { ref } from "vue";
import { connectionStore, testConnection, setConnection, setCredentials } from "../../stores/ssh.js";

const emit = defineEmits(["connect"]);

const mode = ref(connectionStore.mode);
const port = ref(connectionStore.port);
const username = ref(connectionStore.username);
const password = ref(connectionStore.password);

function chooseLocal() {
  mode.value = "local";
  port.value = 4096;
}

function chooseRemote() {
  mode.value = "remote";
}

async function onTest() {
  setCredentials(username.value, password.value);
  await testConnection(port.value, username.value, password.value);
}

function onConnect() {
  setConnection(port.value, mode.value);
  setCredentials(username.value, password.value);
  emit("connect");
}
</script>

<template>
  <div class="connect-screen">
    <div class="connect-card">
      <h1 class="connect-title">Connect to OpenCode</h1>

      <div class="connect-mode-toggle">
        <button
          type="button"
          class="connect-mode-btn"
          :class="{ active: mode === 'local' }"
          @click="chooseLocal"
        >
          Local server
        </button>
        <button
          type="button"
          class="connect-mode-btn"
          :class="{ active: mode === 'remote' }"
          @click="chooseRemote"
        >
          Remote (SSH-forwarded)
        </button>
      </div>

      <label class="connect-field">
        <span class="connect-field-label">Port</span>
        <input
          v-model.number="port"
          type="number"
          min="1"
          max="65535"
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <p v-if="mode === 'remote'" class="connect-help">
        Forward the remote server to a local port first, e.g.
        <code>ssh -L 5000:localhost:4096 user@host</code>, then enter 5000.
      </p>

      <label class="connect-field">
        <span class="connect-field-label">Username</span>
        <input
          v-model="username"
          type="text"
          placeholder="opencode"
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <label class="connect-field">
        <span class="connect-field-label">Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <p class="connect-help">
        Leave password blank if the server has no auth. Enable it by starting the server with
        <code>OPENCODE_SERVER_PASSWORD=…</code>.
      </p>

      <div class="connect-actions">
        <button type="button" :disabled="!port || connectionStore.testing" @click="onTest">
          {{ connectionStore.testing ? "Testing…" : "Test" }}
        </button>
        <button type="button" class="connect-primary" :disabled="!port" @click="onConnect">
          Connect
        </button>
      </div>

      <div v-if="connectionStore.testResult" class="connect-test-result" :class="connectionStore.testResult.ok ? 'ok' : 'fail'">
        {{ connectionStore.testResult.message }}
      </div>

      <p v-if="connectionStore.status === 'failed'" class="connect-fail-note">
        Couldn't reach 127.0.0.1:{{ port }}. Start a local server or set up your SSH forward, then Connect.
      </p>
    </div>
  </div>
</template>

<style scoped>
.connect-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
}

.connect-card {
  width: 100%;
  max-width: 380px;
  padding: 28px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-raised);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.connect-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
}

.connect-mode-toggle {
  display: flex;
  gap: 8px;
}

.connect-mode-btn {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--dim);
  font-size: 12px;
  cursor: pointer;
}

.connect-mode-btn.active {
  color: var(--accent);
  border-color: var(--accent);
}

.connect-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.connect-field-label {
  font-size: 12px;
  color: var(--dim);
}

.connect-field input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}

.connect-field input:focus {
  outline: none;
  border-color: var(--accent);
}

.connect-help {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dim);
}

.connect-help code {
  color: var(--fg);
}

.connect-actions {
  display: flex;
  gap: 8px;
}

.connect-actions button {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
}

.connect-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.connect-primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}

.connect-test-result {
  font-size: 12px;
}

.connect-test-result.ok {
  color: #7fd48a;
}

.connect-test-result.fail {
  color: #e07a7a;
}

.connect-fail-note {
  margin: 0;
  font-size: 12px;
  color: #e07a7a;
}
</style>

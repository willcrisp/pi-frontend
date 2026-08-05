<!--
  The MCP servers this opencode server has loaded.

  Read-only, and deliberately so. MCP servers are declared in opencode's config
  file, which V2 exposes no route to read or write (there is no `/api/config` —
  see docs/opencode-api.md), and config is parsed once at startup and never
  hot-reloaded. An editor here could therefore only write a file the running
  server would ignore until restarted, while looking like it had connected
  something. Where to declare one is spelled out below instead.

  What this answers is the question you actually have when an MCP tool call
  doesn't happen: is the server loaded at all, and did it come up? A failed MCP
  server is silent — the agent simply never calls its tools, which is
  indistinguishable from the agent choosing not to.

  ⚠️ The listing route is NOT verified against a live server (no build in front
  of us at the time of writing exposed one under a name we could confirm), so
  `GET /mcp` is tried and a 404 is reported as "this build doesn't expose it"
  rather than as an error. Both the map and the list response shapes are
  accepted for the same reason. If a verified route lands, replace `loadMcp()`
  and delete this note — do not leave it saying "unverified" once it isn't.
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import { apiGet, errorMessage } from "../../lib/api.js";
import { activeSessionDirectory } from "../../stores/projects.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const emit = defineEmits(["close"]);

const { onBackdrop } = useDialogEscape(() => emit("close"));

const servers = ref([]);
const loading = ref(false);
const error = ref("");
// Set when the server answered 404: not a failure, just a build without the
// route. Worth telling apart — one is worth retrying, the other never will be.
const unsupported = ref(false);

// A server entry, from either response shape. `name` is the key in the map
// form and a field in the list form; everything else is best-effort, because
// the config shape differs between a local (`command`) and a remote (`url`)
// server and neither is guaranteed to be echoed back.
function toServer(name, info) {
  const raw = info && typeof info === "object" ? info : {};
  const command = Array.isArray(raw.command) ? raw.command.join(" ") : raw.command || "";
  return {
    name: name || raw.name || raw.id || "unnamed",
    type: raw.type || (raw.url ? "remote" : command ? "local" : ""),
    target: raw.url || command || "",
    enabled: raw.enabled !== false,
    status: raw.status || raw.state || "",
    error: (raw.error && (raw.error.message || raw.error)) || "",
    tools: Array.isArray(raw.tools) ? raw.tools.length : null,
  };
}

function parse(payload) {
  const body = payload && payload.data !== undefined ? payload.data : payload;
  if (Array.isArray(body)) return body.map((s) => toServer(s && (s.name || s.id), s));
  if (body && typeof body === "object") {
    return Object.entries(body).map(([name, info]) => toServer(name, info));
  }
  return [];
}

async function loadMcp() {
  loading.value = true;
  error.value = "";
  unsupported.value = false;
  try {
    const res = await apiGet("/mcp");
    if (res.status === 404) {
      unsupported.value = true;
      servers.value = [];
      return;
    }
    if (!res.ok) {
      error.value = await errorMessage(res, `Could not list MCP servers (${res.status})`);
      return;
    }
    servers.value = parse(await res.json()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    error.value = e.message || "Could not reach the server";
  } finally {
    loading.value = false;
  }
}

onMounted(loadMcp);

// Where a server would be declared, named concretely for the session in view —
// a generic "your opencode config" is the part people get wrong.
const projectConfig = computed(() => {
  const dir = (activeSessionDirectory() || "").replace(/\/+$/, "");
  return dir ? `${dir}/opencode.json` : "";
});

function statusLabel(server) {
  if (!server.enabled) return "disabled";
  if (server.error) return "failed";
  return server.status || "loaded";
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>MCP servers</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="error" class="connect-error">{{ error }}</p>

      <div v-if="loading" class="connect-hint">Loading…</div>

      <div v-else-if="unsupported" class="connect-hint">
        This build doesn't expose an MCP listing route, so the harness can't say which
        servers are loaded. Their tool calls still show in the transcript.
      </div>

      <div v-else-if="!servers.length && !error" class="connect-hint">
        No MCP servers loaded.
      </div>

      <ul v-else-if="servers.length" class="agents-list">
        <li v-for="server in servers" :key="server.name" class="agents-row readonly">
          <div class="agents-row-main">
            <span class="agents-name">{{ server.name }}</span>
            <span v-if="server.target" class="agents-desc">{{ server.target }}</span>
            <span v-if="server.error" class="mcp-error">{{ server.error }}</span>
          </div>
          <div class="agents-row-meta">
            <span v-if="server.tools !== null" class="mcp-tools">
              {{ server.tools }} {{ server.tools === 1 ? "tool" : "tools" }}
            </span>
            <span class="mcp-status" :class="statusLabel(server)">{{ statusLabel(server) }}</span>
          </div>
        </li>
      </ul>

      <p class="connect-hint mcp-config-hint">
        Servers are declared in
        <code v-if="projectConfig">{{ projectConfig }}</code>
        <code v-else>opencode.json</code>
        or <code>~/.config/opencode/opencode.json</code>, under <code>mcp</code>. opencode
        reads config at startup, so restart the server after editing it.
      </p>

      <div class="connect-actions">
        <button type="button" class="connect-secondary" :disabled="loading" @click="loadMcp">
          Refresh
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agents-row.readonly {
  cursor: default;
}

.mcp-error {
  color: var(--error);
  font-family: var(--mono);
  font-size: 11px;
}

.mcp-tools {
  color: var(--dim);
  font-size: 11px;
}

.mcp-status {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mcp-status.failed {
  border-color: var(--error);
  color: var(--error);
}

.mcp-status.loaded,
.mcp-status.connected {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  color: var(--accent);
}

.mcp-config-hint code {
  font-family: var(--mono);
  font-size: 11px;
  word-break: break-all;
}
</style>

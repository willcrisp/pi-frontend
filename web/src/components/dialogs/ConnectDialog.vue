<!--
  Modal for connecting a model provider (pi's `/login` equivalent), backed by
  auth.js's authStore/`/ws-auth` helper connection. Shows a filterable
  provider list, then the active login flow: OAuth-url/device-code/info
  notices plus whatever prompt step (secret/text/select) the helper is
  currently waiting on.
-->
<script setup>
import { ref, computed } from "vue";
import {
  authStore,
  closeConnect,
  startLogin,
  logout,
  respondPrompt,
  cancelLogin,
} from "../../stores/auth.js";

const filter = ref("");
const promptValue = ref("");

// Only providers offering an interactive login method (some are ambient-only,
// e.g. AWS profile), matching pi's /login provider list.
const visibleProviders = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return authStore.providers
    .filter((p) => p.oauth || p.apiKey)
    .filter((p) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
});

function submitPrompt() {
  respondPrompt(promptValue.value);
  promptValue.value = "";
}

function cancelPrompt() {
  respondPrompt(null);
  promptValue.value = "";
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) closeConnect();
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel">
      <div class="connect-head">
        <span>Connect a model provider</span>
        <button class="connect-close" title="Close" @click="closeConnect">✕</button>
      </div>

      <p v-if="authStore.error" class="connect-error">{{ authStore.error }}</p>

      <!-- Active login flow: notices (OAuth URL / device code / progress) + prompt -->
      <div v-if="authStore.activeProvider" class="connect-flow">
        <div class="connect-flow-title">
          Connecting {{ authStore.activeProvider.name }}…
        </div>

        <div v-for="(n, i) in authStore.notices" :key="i" class="connect-notice">
          <template v-if="n.type === 'auth_url'">
            <div>{{ n.instructions || "Open this URL to authorize:" }}</div>
            <a :href="n.url" target="_blank" rel="noopener" class="connect-link">{{ n.url }}</a>
          </template>
          <template v-else-if="n.type === 'device_code'">
            <div>Enter code <strong>{{ n.userCode }}</strong> at</div>
            <a :href="n.verificationUri" target="_blank" rel="noopener" class="connect-link">{{ n.verificationUri }}</a>
          </template>
          <template v-else-if="n.type === 'info'">
            <div>{{ n.message }}</div>
            <a
              v-for="(l, li) in n.links || []"
              :key="li"
              :href="l.url || l"
              target="_blank"
              rel="noopener"
              class="connect-link"
              >{{ l.label || l.url || l }}</a
            >
          </template>
          <template v-else>
            <div class="connect-progress">{{ n.message }}</div>
          </template>
        </div>

        <!-- Prompt step -->
        <form v-if="authStore.prompt" class="connect-prompt" @submit.prevent="submitPrompt">
          <label>{{ authStore.prompt.message }}</label>

          <template v-if="authStore.prompt.type === 'select'">
            <button
              v-for="opt in authStore.prompt.options"
              :key="opt.id"
              type="button"
              class="connect-option"
              @click="respondPrompt(opt.id)"
            >
              <span>{{ opt.label }}</span>
              <span v-if="opt.description" class="connect-option-desc">{{ opt.description }}</span>
            </button>
          </template>

          <template v-else>
            <input
              v-model="promptValue"
              :type="authStore.prompt.type === 'secret' ? 'password' : 'text'"
              :placeholder="authStore.prompt.placeholder || ''"
              autofocus
            />
            <div class="connect-actions">
              <button type="submit">Submit</button>
              <button type="button" class="connect-secondary" @click="cancelPrompt">Cancel</button>
            </div>
          </template>
        </form>

        <div v-else class="connect-actions">
          <button type="button" class="connect-secondary" @click="cancelLogin">Cancel</button>
        </div>
      </div>

      <!-- Provider picker -->
      <template v-else>
        <input v-model="filter" class="connect-filter" placeholder="Filter providers…" />

        <div v-if="authStore.loading" class="connect-hint">Loading providers…</div>
        <div v-else-if="!visibleProviders.length" class="connect-hint">No matching providers.</div>

        <ul v-else class="connect-list">
          <li v-for="p in visibleProviders" :key="p.id" class="connect-row">
            <div class="connect-row-main">
              <span class="connect-name">{{ p.name }}</span>
              <span v-if="p.status" class="connect-badge">
                connected · {{ p.status.type === "oauth" ? "account" : "API key" }}
              </span>
            </div>
            <div class="connect-row-actions">
              <button
                v-if="p.oauth"
                :disabled="authStore.busy"
                @click="startLogin(p.id, 'oauth')"
              >
                Account
              </button>
              <button
                v-if="p.apiKey"
                :disabled="authStore.busy"
                @click="startLogin(p.id, 'api_key')"
              >
                API key
              </button>
              <button
                v-if="p.status"
                class="connect-secondary"
                :disabled="authStore.busy"
                @click="logout(p.id)"
              >
                Disconnect
              </button>
            </div>
          </li>
        </ul>
      </template>

      <p v-if="authStore.toast" class="connect-toast" :class="{ fail: !authStore.toast.ok }">
        {{ authStore.toast.message }}
      </p>
    </div>
  </div>
</template>

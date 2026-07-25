<!--
  Modal for viewing connected providers and managing API-key credentials.
  Providers/credentials are managed server-side; this dialog lists them from
  /api/provider and /api/credential (both UNVERIFIED — see providers.js).
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import {
  providersStore,
  loadProviders,
  loadCredentials,
  addCredential,
  removeCredential,
} from "../../stores/providers.js";

const emit = defineEmits(["close"]);

const selectedProviderID = ref("");
const apiKey = ref("");
const adding = ref(false);

onMounted(async () => {
  await Promise.all([loadProviders(), loadCredentials()]);
});

function hasCredential(providerID) {
  return providersStore.credentials.some((c) => c.providerID === providerID);
}

const providersWithoutCredential = computed(() =>
  providersStore.providers.filter((p) => !hasCredential(p.id))
);

async function onAdd() {
  if (!selectedProviderID.value || !apiKey.value.trim() || adding.value) return;
  adding.value = true;
  try {
    await addCredential(selectedProviderID.value, apiKey.value.trim());
    selectedProviderID.value = "";
    apiKey.value = "";
  } finally {
    adding.value = false;
  }
}

function onRemove(id) {
  removeCredential(id);
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) emit("close");
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Providers</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="providersStore.error" class="connect-error">{{ providersStore.error }}</p>

      <div v-if="providersStore.loading" class="connect-hint">Loading providers…</div>

      <template v-else>
        <div v-if="!providersStore.providers.length" class="connect-hint">
          No providers available from OpenCode V2 server.
        </div>
        <ul v-else class="agents-list">
          <li v-for="p in providersStore.providers" :key="p.id" class="agents-row">
            <div class="agents-row-main">
              <span class="agents-name">{{ p.name || p.id }}</span>
              <span class="agents-desc">{{ p.id }}</span>
            </div>
            <div class="agents-row-meta">
              <span v-if="hasCredential(p.id)" class="agents-chip">connected</span>
            </div>
          </li>
        </ul>

        <div class="connect-head" style="margin-top: 16px">
          <span>Add credential</span>
        </div>
        <form class="add-project-form" @submit.prevent="onAdd">
          <select v-model="selectedProviderID" class="connect-filter">
            <option value="" disabled>Select a provider…</option>
            <option v-for="p in providersWithoutCredential" :key="p.id" :value="p.id">
              {{ p.name || p.id }}
            </option>
          </select>
          <input
            v-model="apiKey"
            type="password"
            class="connect-filter"
            placeholder="API key"
            autocomplete="off"
          />
          <button type="submit" :disabled="adding || !selectedProviderID || !apiKey.trim()">
            {{ adding ? "adding…" : "Add" }}
          </button>
        </form>

        <div class="connect-head" style="margin-top: 16px">
          <span>Existing credentials</span>
        </div>
        <div v-if="!providersStore.credentials.length" class="connect-hint">No credentials configured.</div>
        <ul v-else class="agents-list">
          <li v-for="c in providersStore.credentials" :key="c.id" class="agents-row">
            <div class="agents-row-main">
              <span class="agents-name">{{ c.providerID }}</span>
            </div>
            <div class="agents-row-meta">
              <button class="icon-btn" title="Remove credential" @click.stop="onRemove(c.id)">✕</button>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

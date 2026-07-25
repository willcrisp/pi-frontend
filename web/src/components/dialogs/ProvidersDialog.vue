<!--
  Modal for managing V2 integrations (~150 provider entries). Each integration
  has `methods` (key/env/oauth) and `connections[]` reflecting what's already
  configured; adding a key posts to /api/integration/{id}/connect/key.
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import {
  providersStore,
  loadIntegrations,
  connectKey,
  removeCredential,
} from "../../stores/providers.js";

const emit = defineEmits(["close"]);

const filter = ref("");
const selectedID = ref("");
const apiKey = ref("");
const adding = ref(false);

onMounted(() => {
  loadIntegrations();
});

const connected = computed(() =>
  providersStore.integrations.filter((i) => (i.connections || []).length > 0)
);

// Only integrations that accept a key (and whose id matches filter, case-insensitive).
const addable = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return providersStore.integrations
    .filter((i) => (i.methods || []).some((m) => m.type === "key"))
    .filter((i) => !q || i.id.toLowerCase().includes(q) || (i.name || "").toLowerCase().includes(q));
});

async function onAdd() {
  if (!selectedID.value || !apiKey.value.trim() || adding.value) return;
  adding.value = true;
  try {
    const ok = await connectKey(selectedID.value, apiKey.value.trim());
    if (ok) {
      apiKey.value = "";
      selectedID.value = "";
    }
  } finally {
    adding.value = false;
  }
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) emit("close");
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Integrations</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="providersStore.error" class="connect-error">{{ providersStore.error }}</p>
      <div v-if="providersStore.loading" class="connect-hint">Loading integrations…</div>

      <template v-else>
        <div class="connect-head" style="margin-top: 4px">
          <span>Connected</span>
        </div>
        <div v-if="!connected.length" class="connect-hint">
          No providers connected. Add one below.
        </div>
        <ul v-else class="agents-list">
          <li v-for="i in connected" :key="i.id" class="agents-row">
            <div class="agents-row-main">
              <span class="agents-name">{{ i.name || i.id }}</span>
              <span class="agents-desc">
                <span v-for="(c, idx) in i.connections" :key="idx">
                  {{ c.type }}{{ c.name ? `: ${c.name}` : "" }}{{ c.label ? ` (${c.label})` : "" }}
                  <button
                    v-if="c.id"
                    class="icon-btn"
                    style="font-size: 11px; padding: 0 4px"
                    title="Remove credential"
                    @click.stop="removeCredential(c.id)"
                  >✕</button>
                </span>
              </span>
            </div>
          </li>
        </ul>

        <div class="connect-head" style="margin-top: 16px">
          <span>Add API key</span>
        </div>
        <form class="add-project-form" @submit.prevent="onAdd">
          <input
            v-model="filter"
            type="text"
            class="connect-filter"
            placeholder="Filter providers…"
          />
          <select v-model="selectedID" class="connect-filter">
            <option value="" disabled>Select a provider…</option>
            <option v-for="i in addable" :key="i.id" :value="i.id">
              {{ i.name || i.id }}
            </option>
          </select>
          <input
            v-model="apiKey"
            type="password"
            class="connect-filter"
            placeholder="API key"
            autocomplete="off"
          />
          <button type="submit" :disabled="adding || !selectedID || !apiKey.trim()">
            {{ adding ? "adding…" : "Add" }}
          </button>
        </form>
      </template>
    </div>
  </div>
</template>

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
  startOAuth,
  completeOAuth,
  cancelOAuth,
  discoverTrueFoundry,
  configureTrueFoundry,
  testTrueFoundryModel,
  restoreTrueFoundryCache,
} from "../../stores/providers.js";
import { opencodeStore } from "../../stores/opencode.js";
import { groupByAccount, TRUEFOUNDRY_PROVIDER_ID } from "../../lib/truefoundry.js";
import { fuzzyScore } from "../../lib/fuzzy.js";
import { readString, writeString } from "../../lib/storage.js";

const emit = defineEmits(["close"]);

const filter = ref("");
const selectedID = ref("");
const apiKey = ref("");
const adding = ref(false);

onMounted(() => {
  loadIntegrations();
  // Show the last discovered catalogue immediately; discovery is a PTY
  // round-trip and re-running it on every open is a stall for a list that
  // rarely changes.
  restoreTrueFoundryCache(tfGateway.value);
});

// --- TrueFoundry -----------------------------------------------------------
// The gateway URL is a durable preference and survives reloads; the PAT never
// touches storage in any form.
const TF_GATEWAY_KEY = "truefoundry.gateway";

const tf = computed(() => providersStore.trueFoundry);
const tfGateway = ref(readString(TF_GATEWAY_KEY, "https://gateway.ai.fortescue.com"));
const tfPAT = ref("");
const tfQuery = ref("");
const tfSelected = ref([]); // model ids
const tfExpanded = ref(new Set()); // provider-account ids
const tfConfiguring = ref(false);

// Set for lookup, array for state: `includes` over a few hundred models runs
// once per checkbox per render, which is the one place the size actually bites.
const tfSelectedSet = computed(() => new Set(tfSelected.value));

// Models this OpenCode already serves under the truefoundry provider — so a
// second visit shows what's live rather than an undifferentiated list.
const tfImported = computed(
  () =>
    new Set(
      (opencodeStore.availableModels || [])
        .filter((m) => m.providerID === TRUEFOUNDRY_PROVIDER_ID)
        .map((m) => m.modelID)
    )
);

// Fuzzy search across id and display name. With ~270 chat models on a real
// tenant, groups alone don't get you to a specific model.
const tfMatches = computed(() => {
  const q = tfQuery.value.trim().toLowerCase();
  if (!q) return tf.value.models;
  return tf.value.models
    .map((m) => ({ m, score: fuzzyScore(q, `${m.name} ${m.id}`.toLowerCase()) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.m);
});

const tfGroups = computed(() => groupByAccount(tfMatches.value));

// Searching expands everything: a match buried in a collapsed group looks like
// no match at all.
function tfIsExpanded(group) {
  return Boolean(tfQuery.value.trim()) || tfExpanded.value.has(group.id);
}

function tfToggleExpanded(group) {
  const next = new Set(tfExpanded.value);
  next.has(group.id) ? next.delete(group.id) : next.add(group.id);
  tfExpanded.value = next;
}

function tfGroupSelected(group) {
  return group.models.length > 0 && group.models.every((m) => tfSelectedSet.value.has(m.id));
}

function tfGroupPartly(group) {
  return !tfGroupSelected(group) && group.models.some((m) => tfSelectedSet.value.has(m.id));
}

function tfToggleGroup(group, checked) {
  const ids = new Set(tfSelected.value);
  for (const m of group.models) checked ? ids.add(m.id) : ids.delete(m.id);
  tfSelected.value = [...ids];
}

function tfToggleModel(model, checked) {
  const ids = new Set(tfSelected.value);
  checked ? ids.add(model.id) : ids.delete(model.id);
  tfSelected.value = [...ids];
}

function tfSelectAll() {
  tfSelected.value = [...new Set([...tfSelected.value, ...tfMatches.value.map((m) => m.id)])];
}

function tfClear() {
  tfSelected.value = [];
}

async function onDiscoverTrueFoundry() {
  writeString(TF_GATEWAY_KEY, tfGateway.value);
  const models = await discoverTrueFoundry(tfGateway.value, tfPAT.value.trim());
  if (!models) return;
  // Keep whatever was already chosen if it still exists, and otherwise start
  // from nothing — a tenant catalogue is far too large to import by accident.
  const live = new Set(models.map((m) => m.id));
  tfSelected.value = tfSelected.value.filter((id) => live.has(id));
}

async function onTestTrueFoundry() {
  const id = tfSelected.value[0];
  if (!id) return;
  await testTrueFoundryModel(tfGateway.value, tfPAT.value.trim(), id);
}

async function onConfigureTrueFoundry() {
  if (!tfSelected.value.length || tfConfiguring.value) return;
  tfConfiguring.value = true;
  try {
    const chosen = tf.value.models.filter((m) => tfSelectedSet.value.has(m.id));
    const ok = await configureTrueFoundry(tfGateway.value, tfPAT.value.trim(), chosen);
    if (ok) tfPAT.value = "";
  } finally {
    tfConfiguring.value = false;
  }
}

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

// Providers that only offer OAuth used to be invisible here — they have no
// key method, so the "Add API key" list filtered them out entirely.
const oauthable = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return providersStore.integrations
    .filter((i) => (i.methods || []).some((m) => m.type === "oauth"))
    .filter((i) => !q || i.id.toLowerCase().includes(q) || (i.name || "").toLowerCase().includes(q));
});

const oauthCode = ref("");

async function onStartOAuth(integrationID) {
  oauthCode.value = "";
  await startOAuth(integrationID);
}

async function onCompleteOAuth() {
  await completeOAuth(oauthCode.value.trim() || null);
}

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
        <!-- TrueFoundry gets its own card rather than a row in the ~150-entry
             integration list: it isn't a server-side integration until a config
             file declares one, and its setup is a two-stage flow. -->
        <section class="tf-card">
          <header class="tf-head">
            <img class="tf-logo" src="/truefoundry.svg" alt="" width="34" height="34" />
            <div>
              <div class="tf-title">TrueFoundry</div>
              <div class="tf-sub">Discover models on your gateway and import the ones you want.</div>
            </div>
          </header>

          <form class="tf-form" @submit.prevent="onDiscoverTrueFoundry">
            <input
              v-model="tfGateway"
              type="url"
              class="connect-filter"
              placeholder="https://gateway.example.com"
              autocomplete="off"
            />
            <input
              v-model="tfPAT"
              type="password"
              class="connect-filter"
              placeholder="Personal access token"
              autocomplete="off"
            />
            <button type="submit" :disabled="tf.busy || !tfPAT.trim()">
              {{ tf.busy ? "discovering…" : "Discover models" }}
            </button>
          </form>

          <p v-if="tf.error" class="connect-error">{{ tf.error }}</p>
          <p v-else-if="tf.notice" class="tf-notice">{{ tf.notice }}</p>

          <template v-if="tf.models.length">
            <div class="tf-toolbar">
              <input
                v-model="tfQuery"
                type="search"
                class="connect-filter tf-search"
                placeholder="Search models…"
              />
              <span class="tf-count">{{ tfSelected.length }} selected</span>
              <button type="button" class="connect-secondary" @click="tfSelectAll">Select all</button>
              <button type="button" class="connect-secondary" @click="tfClear">Clear</button>
            </div>

            <div class="tf-groups">
              <div v-for="group in tfGroups" :key="group.id" class="tf-group">
                <div class="tf-group-head">
                  <input
                    type="checkbox"
                    :checked="tfGroupSelected(group)"
                    :indeterminate="tfGroupPartly(group)"
                    :aria-label="`Select all models in ${group.id}`"
                    @change="tfToggleGroup(group, $event.target.checked)"
                  />
                  <button type="button" class="tf-group-toggle" @click="tfToggleExpanded(group)">
                    <span class="tf-caret" :class="{ open: tfIsExpanded(group) }">▸</span>
                    <span class="tf-group-name">{{ group.id }}</span>
                    <!-- The broad provider type only earns space when it says
                         something the account name doesn't. -->
                    <span v-if="group.provider && group.provider !== group.id" class="tf-group-type">
                      {{ group.provider }}
                    </span>
                    <span class="tf-group-count">{{ group.models.length }}</span>
                  </button>
                </div>

                <ul v-if="tfIsExpanded(group)" class="tf-models">
                  <li v-for="model in group.models" :key="model.id" class="tf-model">
                    <label>
                      <input
                        type="checkbox"
                        :checked="tfSelectedSet.has(model.id)"
                        @change="tfToggleModel(model, $event.target.checked)"
                      />
                      <!-- Fully-qualified ids run long enough to ellipsize at
                           this width, so the whole thing is on hover. -->
                      <span class="tf-model-name" :title="model.name">{{ model.name }}</span>
                      <span class="tf-model-id" :title="model.id">{{ model.id }}</span>
                      <span v-if="tfImported.has(model.id)" class="tf-badge">imported</span>
                    </label>
                  </li>
                </ul>
              </div>
            </div>

            <div class="tf-actions">
              <button
                type="button"
                :disabled="!tfSelected.length || tf.busy || tfConfiguring"
                @click="onConfigureTrueFoundry"
              >
                {{ tfConfiguring ? "saving…" : `Add ${tfSelected.length} selected model${tfSelected.length === 1 ? "" : "s"}` }}
              </button>
              <!-- Being listed is not being callable: the enabled endpoint
                   reports inventory, not whether this PAT can invoke it. -->
              <button
                type="button"
                class="connect-secondary"
                :disabled="!tfSelected.length || tf.testing || !tfPAT.trim()"
                @click="onTestTrueFoundry"
              >
                {{ tf.testing ? "testing…" : "Test first selection" }}
              </button>
            </div>

            <p v-if="tf.testResult" class="tf-test" :class="{ bad: !tf.testResult.ok }">
              {{ tf.testResult.ok ? "✓" : "✕" }} {{ tf.testResult.message }}
            </p>
          </template>

          <p class="tf-privacy">
            Models are added to your global OpenCode config, so they're available in every project.
            The token is sent to your OpenCode host to reach the gateway — it is never written to a
            config file or to browser storage.
          </p>
        </section>

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

        <template v-if="oauthable.length">
          <div class="connect-head" style="margin-top: 16px">
            <span>Sign in with OAuth</span>
          </div>

          <!-- An attempt is in flight: the user has to leave the app,
               authorize there, and come back. Keep the attempt on screen the
               whole time so returning doesn't mean starting over. -->
          <div v-if="providersStore.oauthAttempt" class="oauth-attempt">
            <div class="connect-hint">
              {{ providersStore.oauthAttempt.instructions || "Authorize in the page that opens, then finish here." }}
            </div>
            <a
              v-if="providersStore.oauthAttempt.url"
              class="oauth-link"
              :href="providersStore.oauthAttempt.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open authorization page ↗
            </a>
            <div v-if="providersStore.oauthAttempt.userCode" class="connect-hint">
              Code to enter there: <strong>{{ providersStore.oauthAttempt.userCode }}</strong>
            </div>
            <form class="add-project-form" @submit.prevent="onCompleteOAuth">
              <input
                v-model="oauthCode"
                type="text"
                class="connect-filter"
                placeholder="Paste the code from the provider (if it gave one)"
                autocomplete="off"
              />
              <button type="submit" :disabled="providersStore.oauthAttempt.busy">
                {{ providersStore.oauthAttempt.busy ? "finishing…" : "Finish sign-in" }}
              </button>
              <button type="button" class="connect-secondary" @click="cancelOAuth">Cancel</button>
            </form>
          </div>

          <ul v-else class="agents-list">
            <li v-for="i in oauthable" :key="i.id" class="agents-row">
              <div class="agents-row-main">
                <span class="agents-name">{{ i.name || i.id }}</span>
              </div>
              <div class="agents-row-meta">
                <button type="button" @click="onStartOAuth(i.id)">Sign in</button>
              </div>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.oauth-attempt {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.oauth-link {
  color: var(--accent);
  font-size: 12px;
}

/* TrueFoundry card. Scoped rather than a partial in src/styles/: it belongs to
   this one component, and src/style.css resolves ties by import order. */
.tf-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tf-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tf-logo {
  flex: none;
  border-radius: 8px;
}

.tf-title {
  font-weight: 600;
}

.tf-sub,
.tf-privacy {
  font-size: 11px;
  color: var(--text-dim);
}

/* The gateway URL gets its own row: at the dialog's 460px a three-column split
   truncated it mid-host and wrapped the button onto two lines. */
.tf-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
}

.tf-form input[type="url"] {
  grid-column: 1 / -1;
}

.tf-form button {
  white-space: nowrap;
}

.tf-notice {
  font-size: 12px;
  color: var(--accent);
  margin: 0;
}

.tf-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tf-search {
  flex: 1;
  min-width: 0;
}

.tf-count {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}

/* Hundreds of models on a real tenant, so the list scrolls inside the card
   instead of stretching the dialog past the viewport. */
.tf-groups {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.tf-group + .tf-group {
  border-top: 1px solid var(--border);
}

.tf-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
}

.tf-group-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.tf-caret {
  display: inline-block;
  transition: transform 0.12s ease;
  color: var(--text-dim);
  font-size: 10px;
}

.tf-caret.open {
  transform: rotate(90deg);
}

.tf-group-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tf-group-type {
  font-size: 11px;
  color: var(--text-dim);
}

.tf-group-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}

.tf-models {
  list-style: none;
  margin: 0;
  padding: 0 0 4px 26px;
}

.tf-model label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px 3px 0;
  cursor: pointer;
  min-width: 0;
}

.tf-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tf-model-id {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tf-badge {
  margin-left: auto;
  flex: none;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}

.tf-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tf-test {
  margin: 0;
  font-size: 12px;
  color: var(--accent);
}

.tf-test.bad {
  color: var(--danger, #e5534b);
}

@media (max-width: 640px) {
  .tf-form {
    grid-template-columns: 1fr;
  }

  /* The search box and the three controls beside it don't fit on one line at
     phone widths — unwrapped, the input collapses to a sliver. */
  .tf-toolbar {
    flex-wrap: wrap;
  }

  .tf-search {
    flex: 1 0 100%;
  }
}
</style>

<!--
  Manage the always-allow rules created by clicking "Allow always" in
  PermissionDialog. The server persists those (GET /api/permission/saved);
  this is the only route back from one — without it a single mis-click grants
  a tool indefinitely.

  Read-and-revoke only: there is no create/edit route, and inventing one
  client-side would be a lie about what the server enforces.
-->
<script setup>
import { computed, onMounted } from "vue";
import {
  permissionStore,
  loadSavedPermissions,
  revokeSavedPermission,
} from "../../stores/permission.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const emit = defineEmits(["close"]);

const { onBackdrop } = useDialogEscape(() => emit("close"));

onMounted(loadSavedPermissions);

// The stored-rule shape isn't pinned down beyond carrying an id, so render
// whichever of the identifying fields the server actually sends and fall back
// to the raw JSON rather than showing an empty row.
const rules = computed(() =>
  permissionStore.saved.map((r, i) => ({
    id: r?.id ?? String(i),
    action: r?.action || r?.permission || r?.type || "",
    resources: Array.isArray(r?.resources) ? r.resources : r?.resource ? [r.resource] : [],
    raw: r,
  }))
);

function detail(rule) {
  if (rule.action || rule.resources.length) return "";
  try {
    return JSON.stringify(rule.raw);
  } catch {
    return String(rule.raw);
  }
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span>Saved permissions</span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="permissionStore.savedError" class="connect-error">{{ permissionStore.savedError }}</p>

      <div v-if="permissionStore.savedLoading" class="connect-hint">Loading…</div>
      <div v-else-if="!rules.length" class="connect-hint">
        No always-allow rules saved. Clicking “Allow always” on a permission prompt adds one here.
      </div>

      <ul v-else class="agents-list">
        <li v-for="rule in rules" :key="rule.id" class="agents-row readonly">
          <div class="agents-row-main">
            <span class="agents-name">{{ rule.action || rule.id }}</span>
            <span v-if="rule.resources.length" class="agents-desc">{{ rule.resources.join(", ") }}</span>
            <span v-else-if="detail(rule)" class="agents-desc">{{ detail(rule) }}</span>
          </div>
          <div class="agents-row-meta">
            <button type="button" class="connect-secondary" @click="revokeSavedPermission(rule.id)">
              Revoke
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.agents-row.readonly {
  cursor: default;
}
</style>

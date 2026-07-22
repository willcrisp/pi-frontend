<!--
  Composer control: a small pill button toggling the global rtk setting
  (stores/rtk.js) — on ensures the pi extension is installed and spawns pi
  with no special env, off spawns pi with RTK_DISABLED=1 (never uninstalls
  anything). Global, not per-project, so it refetches whenever the SSH
  target changes rather than on project switch.
-->
<script setup>
import { onMounted, watch } from "vue";
import { rtkStore, fetchRtkStatus, setRtkEnabled } from "../../stores/rtk.js";
import { sshStore } from "../../stores/ssh.js";
import { alertDialog } from "../../stores/confirm.js";

onMounted(fetchRtkStatus);

watch(
  () => sshStore.host,
  () => fetchRtkStatus()
);

async function toggle() {
  if (rtkStore.saving) return;
  try {
    await setRtkEnabled(!rtkStore.enabled);
  } catch (e) {
    await alertDialog({ title: "rtk", message: rtkStore.error || e.message || String(e) });
  }
}

function title() {
  if (rtkStore.loaded && !rtkStore.available) {
    return rtkStore.probeError ? `rtk not available: ${rtkStore.probeError}` : "rtk not installed on the pi host";
  }
  const version = rtkStore.version ? ` ${rtkStore.version}` : "";
  return `rtk${version} — output compression ${rtkStore.enabled ? "on" : "off"}`;
}
</script>

<template>
  <button
    type="button"
    class="rtk-toggle"
    :class="{ on: rtkStore.enabled }"
    :disabled="rtkStore.saving"
    :title="title()"
    @click="toggle"
  >
    rtk
  </button>
</template>

<!--
  Composer control: a small pill button toggling rtk output compression for
  the current chat (stores/rtk.js) — on ensures the pi extension is installed
  (host-wide) and spawns this chat's pi with no special env, off spawns it
  with RTK_DISABLED=1 (never uninstalls anything). Per-chat, so it refetches
  on chat switch as well as whenever the SSH target changes (the binary/
  extension probe is still host-wide).
-->
<script setup>
import { watch } from "vue";
import { rtkStore, fetchRtkStatus, setRtkEnabled } from "../../stores/rtk.js";
import { sshStore } from "../../stores/ssh.js";
import { activeChat } from "../../stores/pi.js";
import { alertDialog } from "../../stores/confirm.js";

watch(() => [activeChat.projectId, activeChat.chatId], fetchRtkStatus, { immediate: true });

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
    return rtkStore.probeError
      ? `rtk not available on the pi host: ${rtkStore.probeError}`
      : "rtk not installed on the pi host";
  }
  const version = rtkStore.version ? ` ${rtkStore.version}` : "";
  return `rtk${version} — output compression ${rtkStore.enabled ? "on" : "off"} for this chat`;
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

// Document title + favicon updater: reflects "<project> - <session>" and tints
// the radius mark yellow (streaming) / green (idle) so a background tab shows
// agent status at a glance.
//
// Key export:
//   initPageTitle() — wired once from main.js; watches projectsStore/store
//     and updates document.title + the favicon <link> on any change.
import { watch } from "vue";
import { projectsStore } from "../stores/projects.js";
import { store } from "../stores/pi.js";

// Status-tinted variant of public/favicon.svg — keep the two in sync.
function createFavicon(isWorking) {
  const color = isWorking ? "#fbbf24" : "#22c55e"; // yellow if working, green if ready
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#0c0e10"/>
    <circle cx="16" cy="16" r="10" fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="2.2"/>
    <path d="M16 16 L23.1 8.9" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="16" cy="16" r="2" fill="${color}"/>
  </svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function updatePageTitle() {
  const currentProject = projectsStore.projects.find(
    (p) => p.id === projectsStore.currentProjectId
  );
  const projectName = currentProject?.name || "radius";
  const sessionName = store.sessionName || "untitled";

  const title = `${projectName} - ${sessionName}`;

  document.title = title;

  // Update favicon
  const faviconLink = document.querySelector("link[rel='icon']") || (() => {
    const link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
    return link;
  })();
  faviconLink.href = createFavicon(store.streaming);
}

export function initPageTitle() {
  // Watch for changes in project/session/status
  watch(
    () => [
      projectsStore.currentProjectId,
      store.sessionName,
      store.streaming,
    ],
    updatePageTitle,
    { immediate: true }
  );
}

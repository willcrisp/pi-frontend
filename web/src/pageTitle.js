import { watch } from "vue";
import { projectsStore } from "./projects.js";
import { store } from "./pi.js";

function createFavicon(isWorking) {
  const color = isWorking ? "#fbbf24" : "#22c55e"; // yellow if working, green if ready
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="6" fill="${color}"/>
  </svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function updatePageTitle() {
  const currentProject = projectsStore.projects.find(
    (p) => p.id === projectsStore.currentProjectId
  );
  const projectName = currentProject?.name || "pi";
  const sessionName = store.sessionName || "untitled";

  const statusDot = store.streaming ? "🟨" : "🟢";
  const title = `${statusDot} ${projectName} - ${sessionName}`;

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

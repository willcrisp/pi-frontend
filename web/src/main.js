// App entry point: wires the session-switch callback between pi.js and
// projects.js (so a settled/switched chat refreshes the sidebar's session
// list), boots the project list, starts the page-title/favicon watcher, and
// mounts App.vue.
import { createApp } from "vue";
import App from "./App.vue";
import { setOnSessionSwitched } from "./stores/pi.js";
import { initProjects, refreshCurrentSessions } from "./stores/projects.js";
import { initPageTitle } from "./lib/pageTitle.js";
import "./style.css";

setOnSessionSwitched(refreshCurrentSessions);
initProjects();
initPageTitle();
createApp(App).mount("#app");

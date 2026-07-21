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

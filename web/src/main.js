import { createApp } from "vue";
import App from "./App.vue";
import { setOnSessionSwitched } from "./pi.js";
import { initProjects, refreshCurrentSessions } from "./projects.js";
import { initPageTitle } from "./pageTitle.js";
import "./style.css";

setOnSessionSwitched(refreshCurrentSessions);
initProjects();
initPageTitle();
createApp(App).mount("#app");

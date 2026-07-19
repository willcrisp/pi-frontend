import { createApp } from "vue";
import App from "./App.vue";
import { setOnSessionSwitched } from "./pi.js";
import { initProjects, refreshCurrentSessions } from "./projects.js";
import "./style.css";

setOnSessionSwitched(refreshCurrentSessions);
initProjects();
createApp(App).mount("#app");

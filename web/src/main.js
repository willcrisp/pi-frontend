import { createApp } from "vue";
import App from "./App.vue";
import { initOpenCode } from "./stores/opencode.js";
import { initProjects } from "./stores/projects.js";
import "./style.css";

initOpenCode();
initProjects();

createApp(App).mount("#app");

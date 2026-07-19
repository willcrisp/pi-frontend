import { createApp } from "vue";
import App from "./App.vue";
import { connect } from "./pi.js";
import "./style.css";

connect();
createApp(App).mount("#app");

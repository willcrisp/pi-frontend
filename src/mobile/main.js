// Entry point for the Android build.
//
// A separate entry rather than a responsive mode of the desktop app, because
// "boil it down" is the whole point: this mounts a different component tree
// (four screens, no settings, no dialogs beyond the two blocking gates) on top
// of the *same* store layer. Everything under src/stores/opencode/ — the SSE
// reducer, run-end reconciliation, steering, transcript normalization — is
// shared verbatim with the desktop app and must stay that way; a fix to the
// engine should never need doing twice.
import { createApp } from "vue";
import App from "./App.vue";
import "./mobile.css";

createApp(App).mount("#app");

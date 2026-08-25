// Tells the Android notification service where the server is, and whether the
// app is on screen.
//
// The channel is a plain POST to `/_radius/*` on the app's own origin, answered
// natively by LocalProxy's control handler. There is no Capacitor bridge here —
// the app is loaded from the proxy's URL rather than Capacitor's asset scheme —
// and this needs none: the JS already speaks HTTP to that origin.
//
// In a browser (`npm run dev:mobile`, or the bundle served for testing) nothing
// answers those paths and every call 404s, which is exactly right — there is no
// service to configure, and the app must not care.
import { connectionStore, authHeaders } from "../../stores/ssh.js";

let available = true;

async function control(path, body) {
  // One 404 means we are not on the device. Latch it rather than firing a
  // doomed request on every visibility change for the rest of the session.
  if (!available) return null;
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 404) {
      available = false;
      return null;
    }
    return res.ok ? await res.json() : null;
  } catch {
    available = false;
    return null;
  }
}

// Hand the service the connection the app is actually using, rather than having
// native code read localStorage — one source of truth for where the server is.
export function startWatching(visible = true) {
  return control("/_radius/watch", {
    scheme: connectionStore.secure ? "https" : "http",
    host: connectionStore.host,
    port: connectionStore.port,
    // The same header lib/api.js sends. The service needs it for its own
    // connection, which does not go through the app at all.
    auth: authHeaders().Authorization || null,
    visible,
  });
}

// Nothing is notified while the app is on screen — the UI already shows all of
// it, and a notification for something you are looking at is noise.
export function setAppVisible(visible) {
  return control("/_radius/visibility", { visible });
}

export function stopWatching() {
  return control("/_radius/stop", {});
}

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import httpProxy from "http-proxy";

// Forwards /api/<host>:<port>/<rest> -> http://<host>:<port>/<rest> (SSE-safe).
//
// `<host>:` is optional and defaults to 127.0.0.1, so the older /api/<port>/…
// form still works. The address lives in the URL rather than in this file's
// config because the Android build's in-app proxy (android/…/LocalProxy.java)
// parses the exact same prefix — one addressing scheme, and neither proxy needs
// to be told anything by the JS. See apiBase() in src/stores/ssh.js.
const API_PREFIX = /^\/api\/(?:([A-Za-z0-9._-]+):)?(\d+)(\/.*)$/;

// Only ever forward to a private address. The prefix is attacker-controllable in
// the sense that any page the dev server serves can name a target, and a dev
// server that will proxy to arbitrary internet hosts is an open relay.
function isPrivateHost(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true; // tailscale CGNAT
  return /\.(local|internal|ts\.net)$/.test(host);
}
function opencodeDynamicProxy() {
  const proxy = httpProxy.createProxyServer({ changeOrigin: true });
  // Strip the Basic-auth challenge off any 401 coming back from opencode2.
  //
  // Not cosmetic: a browser that sees `WWW-Authenticate: Basic` on a 401 opens
  // its own native credential prompt and does not settle the fetch until that
  // prompt is answered. A WebView shows no such prompt, so the promise simply
  // never resolves — one wrong password and the app hangs on a spinner with no
  // error, forever. (Verified: the fetch hangs indefinitely, and
  // `credentials: "omit"` does not avoid it.) With the header gone the 401
  // arrives as an ordinary response the app can report.
  //
  // The Android proxy does the same thing for the same reason — see
  // rewriteResponseHead() in LocalProxy.java.
  proxy.on("proxyRes", (proxyRes) => {
    delete proxyRes.headers["www-authenticate"];
  });
  proxy.on("error", (err, _req, res) => {
    if (res && !res.headersSent && res.writeHead) res.writeHead(502);
    if (res && res.end) res.end(`opencode proxy error: ${err.message}`);
  });
  return {
    name: "opencode-dynamic-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url && req.url.match(API_PREFIX);
        if (!m) return next();
        const host = m[1] || "127.0.0.1";
        if (!isPrivateHost(host)) {
          res.writeHead(403);
          return res.end(`refusing to proxy to non-private host ${host}`);
        }
        req.url = m[3]; // strip /api/<host>:<port>
        proxy.web(req, res, { target: `http://${host}:${m[2]}` });
      });
      // WebSocket upgrades (PTY connect) — middlewares only see HTTP requests,
      // so forward upgrade events on the underlying HTTP server ourselves.
      // Skip Vite's own HMR socket (no /api/<port> prefix) so it keeps working.
      server.httpServer?.on("upgrade", (req, socket, head) => {
        const m = req.url && req.url.match(API_PREFIX);
        if (!m) return;
        const host = m[1] || "127.0.0.1";
        if (!isPrivateHost(host)) return socket.destroy();
        req.url = m[3];
        proxy.ws(req, socket, head, { target: `http://${host}:${m[2]}` });
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), opencodeDynamicProxy()],
  server: { port: 5173, strictPort: true },
});

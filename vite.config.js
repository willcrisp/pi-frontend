import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import httpProxy from "http-proxy";

// Forwards /api/<scheme>/<host>:<port>/<rest> -> <scheme>://<host>:<port>/<rest>
// (SSE-safe). The address lives in the URL rather than in this file's config
// because the Android build's in-app proxy (android/…/LocalProxy.java) parses
// the exact same prefix — one addressing scheme, and neither proxy needs to be
// told anything by the JS. See apiBase() in src/stores/ssh.js.
//
// The scheme is in the prefix because the two ways of reaching a server differ
// on it: a tunnelled or LAN server is plain http, while a Coder port-forward URL
// is https on 443 with the port encoded in the hostname. Every part is
// mandatory — apiBase() always writes all three — so there is one form to parse
// in all three implementations rather than a nest of optional pieces.
const API_PREFIX = /^\/api\/(https?)\/([A-Za-z0-9._-]+):(\d+)(\/.*)$/;

// Only ever forward to a private address. The prefix is attacker-controllable in
// the sense that any page the dev server serves can name a target, and a dev
// server that will proxy to arbitrary internet hosts is an open relay.
function isPrivateHost(host) {
  // A TLS target is a named, publicly-resolvable host by definition (a Coder
  // workspace URL), so the private-address rule below cannot apply to it. The
  // protection there is that opencode2 still demands its own Basic auth.
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
        const [, scheme, host, port] = m;
        if (scheme === "http" && !isPrivateHost(host)) {
          res.writeHead(403);
          return res.end(`refusing to proxy cleartext to non-private host ${host}`);
        }
        req.url = m[4]; // strip /api/<scheme>/<host>:<port>
        proxy.web(req, res, { target: `${scheme}://${host}:${port}`, secure: true });
      });
      // WebSocket upgrades (PTY connect) — middlewares only see HTTP requests,
      // so forward upgrade events on the underlying HTTP server ourselves.
      // Skip Vite's own HMR socket (no /api/<port> prefix) so it keeps working.
      server.httpServer?.on("upgrade", (req, socket, head) => {
        const m = req.url && req.url.match(API_PREFIX);
        if (!m) return;
        const [, scheme, host, port] = m;
        if (scheme === "http" && !isPrivateHost(host)) return socket.destroy();
        req.url = m[4];
        proxy.ws(req, socket, head, { target: `${scheme}://${host}:${port}`, secure: true });
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), opencodeDynamicProxy()],
  server: { port: 5173, strictPort: true },
});

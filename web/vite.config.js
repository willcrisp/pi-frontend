import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import httpProxy from "http-proxy";

// Forwards /api/<port>/<rest> -> http://127.0.0.1:<port>/<rest> (localhost only, SSE-safe).
function opencodeDynamicProxy() {
  const proxy = httpProxy.createProxyServer({ changeOrigin: true });
  proxy.on("error", (err, _req, res) => {
    if (res && !res.headersSent && res.writeHead) res.writeHead(502);
    if (res && res.end) res.end(`opencode proxy error: ${err.message}`);
  });
  return {
    name: "opencode-dynamic-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url && req.url.match(/^\/api\/(\d+)(\/.*)$/);
        if (!m) return next();
        const port = m[1];
        req.url = m[2]; // strip /api/<port>
        proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), opencodeDynamicProxy()],
  server: { port: 5173, strictPort: true },
});

package dev.radius.mobile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The app's own HTTP server, on 127.0.0.1 only.
 *
 * <p>WHY THIS EXISTS. The opencode2 server sends no CORS headers on any route and
 * answers the OPTIONS preflight with a 404 (verified against a live server), so a
 * WebView can never call it cross-origin — not with fetch, not with EventSource.
 * Loading the whole app from this proxy instead makes every request same-origin,
 * which:
 *
 * <ul>
 *   <li>removes CORS from the picture entirely;
 *   <li>keeps SSE actually streaming, which a native-HTTP bridge plugin would not
 *       (and the SSE stream is how every message in the app arrives);
 *   <li>keeps WebSocket upgrades working, so the PTY routes survive;
 *   <li>satisfies the PTY connect-token's own same-origin check.
 * </ul>
 *
 * <p>It is the same thing the Vite dev proxy does in vite.config.js, and it reads
 * the upstream address off the URL in the same format — {@code /api/<host>:<port>/…}
 * — so the JavaScript never has to tell either proxy anything. See apiBase() in
 * src/stores/ssh.js. Keeping the two in step matters: a change to that prefix is a
 * change in three places.
 *
 * <p>Everything not under /api/ is served from the APK's bundled web assets.
 *
 * <p>DELIBERATELY FREE OF ANDROID IMPORTS. Assets come in through {@link
 * AssetSource} rather than an AssetManager so this class is plain Java and can be
 * exercised off-device — see tools/proxy-test/ProxyTest.java, which runs real
 * requests, a real SSE stream and a real WebSocket upgrade through this exact
 * file. It is the piece of the port with the least margin for error and the
 * hardest to debug on a phone, so it is the piece that gets tested directly.
 */
public class LocalProxy {

    /**
     * Fixed because capacitor.config.json's server.url has to name it at build
     * time. High and arbitrary to stay clear of anything else on the device.
     */
    public static final int PORT = 47653;

    /** Mirrors API_PREFIX in vite.config.js. The host part is optional. */
    private static final Pattern API_PREFIX =
            Pattern.compile("^/api/(?:([A-Za-z0-9._\\-]+):)?(\\d+)(/.*)$");

    private static final int UPSTREAM_CONNECT_TIMEOUT_MS = 8000;

    /** Where bundled web assets come from. On Android this wraps AssetManager. */
    public interface AssetSource {
        InputStream open(String path) throws IOException;
    }

    private final AssetSource assets;
    private ServerSocket server;
    /** Unbounded: a connection here is nearly all blocked-on-IO time, and the
     *  long-lived ones (the SSE stream, a PTY socket) hold their thread for the
     *  life of the stream. A fixed pool would deadlock once those filled it. */
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public LocalProxy(AssetSource assets) {
        this.assets = assets;
    }

    public void start() throws IOException {
        // Bound to loopback explicitly: this proxy will connect onward to
        // whatever host the URL names, so anything that could reach it from off
        // the device would have an open relay.
        server = new ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"));
        pool.execute(() -> {
            while (!server.isClosed()) {
                try {
                    Socket client = server.accept();
                    pool.execute(() -> handle(client));
                } catch (IOException e) {
                    // System.err rather than android.util.Log to keep this class
                    // Android-free; Android routes System.err to logcat anyway.
                    if (!server.isClosed()) System.err.println("LocalProxy: accept failed: " + e);
                }
            }
        });
    }

    public void stop() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    private void handle(Socket client) {
        try {
            InputStream in = client.getInputStream();
            byte[] head = readHead(in);
            if (head == null) {
                client.close();
                return;
            }
            String headText = new String(head, StandardCharsets.ISO_8859_1);
            String requestLine = headText.substring(0, indexOfLineEnd(headText));
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) {
                client.close();
                return;
            }
            String method = parts[0];
            String target = parts[1];

            Matcher m = API_PREFIX.matcher(target);
            if (m.matches()) {
                String host = m.group(1) == null ? "127.0.0.1" : m.group(1);
                int port = Integer.parseInt(m.group(2));
                proxy(client, in, headText, method, m.group(3), host, port);
            } else {
                serveAsset(client, target);
            }
        } catch (IOException e) {
            closeQuietly(client);
        }
    }

    // ── Proxying ────────────────────────────────────────────────────────────

    private void proxy(
            Socket client,
            InputStream clientIn,
            String headText,
            String method,
            String path,
            String host,
            int port)
            throws IOException {
        Socket upstream = new Socket();
        try {
            upstream.connect(new InetSocketAddress(host, port), UPSTREAM_CONNECT_TIMEOUT_MS);
        } catch (IOException e) {
            // A phone changes networks constantly, so a dead upstream is routine
            // rather than exceptional. Answering with a status the app can show
            // beats dropping the socket, which surfaces as an opaque "load
            // failed" with nothing to act on.
            writeSimple(client, 502, "text/plain", ("cannot reach " + host + ":" + port).getBytes(StandardCharsets.UTF_8));
            closeQuietly(client);
            return;
        }

        OutputStream up = upstream.getOutputStream();
        up.write(rewriteRequestHead(headText, method, path, host, port).getBytes(StandardCharsets.ISO_8859_1));
        up.flush();

        // Body (a POST) and anything the client sends later on this connection —
        // a WebSocket's frames after the upgrade. Its own thread, because the
        // response can start arriving before the request body is finished.
        pool.execute(() -> pump(clientIn, up));

        // The response head is rewritten (see below); everything after it is
        // copied through untouched, which is what keeps SSE streaming and lets a
        // WebSocket's binary frames past.
        InputStream down = upstream.getInputStream();
        OutputStream toClient = client.getOutputStream();
        byte[] responseHead = readHead(down);
        if (responseHead != null) {
            String rewritten = rewriteResponseHead(new String(responseHead, StandardCharsets.ISO_8859_1));
            toClient.write(rewritten.getBytes(StandardCharsets.ISO_8859_1));
            toClient.flush();
            pump(down, toClient);
        }
        closeQuietly(upstream);
        closeQuietly(client);
    }

    /**
     * Strip the proxy prefix off the path, point Host at the real upstream, and
     * force the connection closed after this exchange.
     *
     * <p>The {@code Connection: close} is not a detail. Without it the browser
     * would reuse the socket for its next request — and that request still
     * carries the {@code /api/<host>:<port>} prefix, which the upstream has never
     * heard of. One request per connection keeps every request going through the
     * rewrite above. Long-lived streams (SSE, a PTY WebSocket) are unaffected:
     * they are one request that simply never ends.
     */
    private String rewriteRequestHead(String headText, String method, String path, String host, int port) {
        StringBuilder out = new StringBuilder();
        out.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
        boolean upgrade = headText.toLowerCase(Locale.ROOT).contains("upgrade: websocket");
        for (String line : splitHeaderLines(headText)) {
            if (line.isEmpty()) continue;
            String lower = line.toLowerCase(Locale.ROOT);
            if (lower.startsWith("host:")
                    || lower.startsWith("connection:")
                    || lower.startsWith("proxy-connection:")
                    // The page's own origin means nothing upstream, and sending
                    // it invites a server that does check origins to reject us.
                    || lower.startsWith("origin:")
                    || lower.startsWith("referer:")) {
                continue;
            }
            out.append(line).append("\r\n");
        }
        out.append("Host: ").append(host).append(':').append(port).append("\r\n");
        // A WebSocket handshake must keep its own Connection: Upgrade, or the
        // upgrade never happens and the PTY routes stop working.
        out.append(upgrade ? "Connection: Upgrade\r\n" : "Connection: close\r\n");
        out.append("\r\n");
        return out.toString();
    }

    /**
     * Drop the Basic-auth challenge from a 401.
     *
     * <p>A browser that sees {@code WWW-Authenticate: Basic} on a 401 opens its
     * own credential prompt and leaves the fetch pending until that prompt is
     * answered. A WebView shows no such prompt, so the promise never settles:
     * one wrong password and the app hangs on a spinner with no error, forever.
     * (Verified in a real browser — {@code credentials: "omit"} does not avoid
     * it.) With the header gone the 401 arrives as an ordinary response the app
     * reports as "authentication failed". vite.config.js does the same thing.
     */
    private String rewriteResponseHead(String headText) {
        boolean switchingProtocols = headText.startsWith("HTTP/1.1 101");
        StringBuilder out = new StringBuilder();
        String[] lines = splitAll(headText);
        out.append(lines[0]).append("\r\n");
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i];
            if (line.isEmpty()) continue;
            String lower = line.toLowerCase(Locale.ROOT);
            if (lower.startsWith("www-authenticate:")) continue;
            // The upstream's own connection semantics were answered to the
            // request WE sent, not the one the browser sent. Re-stated below.
            if (!switchingProtocols && lower.startsWith("connection:")) continue;
            out.append(line).append("\r\n");
        }
        if (!switchingProtocols) out.append("Connection: close\r\n");
        out.append("\r\n");
        return out.toString();
    }

    // ── Static assets ───────────────────────────────────────────────────────

    private void serveAsset(Socket client, String target) throws IOException {
        String path = target;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        // The app is a single page with no client-side routing, so anything that
        // isn't a real file is a bad URL rather than a route — but index.html is
        // still the only sane fallback, and it costs nothing.
        String assetPath = "public" + path;

        byte[] body;
        try {
            body = readAll(assets.open(assetPath));
        } catch (IOException e) {
            try {
                body = readAll(assets.open("public/index.html"));
                assetPath = "public/index.html";
            } catch (IOException e2) {
                writeSimple(client, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
                closeQuietly(client);
                return;
            }
        }
        writeSimple(client, 200, contentType(assetPath), body);
        closeQuietly(client);
    }

    private static String contentType(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json") || p.endsWith(".map")) return "application/json; charset=utf-8";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private void writeSimple(Socket client, int status, String type, byte[] body) throws IOException {
        OutputStream out = client.getOutputStream();
        String head =
                "HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Error") + "\r\n"
                        + "Content-Type: " + type + "\r\n"
                        + "Content-Length: " + body.length + "\r\n"
                        // The assets are rebuilt into the APK on every install, so
                        // a cached copy can only ever be stale.
                        + "Cache-Control: no-store\r\n"
                        + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    // ── Plumbing ────────────────────────────────────────────────────────────

    /** Read up to and including the blank line that ends an HTTP head. */
    private static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0; // how much of \r\n\r\n has been seen
        while (true) {
            int b = in.read();
            if (b == -1) return buf.size() == 0 ? null : buf.toByteArray();
            buf.write(b);
            if (b == '\r') state = (state == 2) ? 3 : 1;
            else if (b == '\n') {
                if (state == 1) state = 2;
                else if (state == 3) return buf.toByteArray();
                else state = 0;
            } else state = 0;
        }
    }

    /**
     * Copy until the source ends, flushing every chunk.
     *
     * <p>The flush is the whole point: SSE delivers one small event at a time and
     * a buffered copy would hold each one until something else filled the buffer.
     * That reads as an app where messages arrive in bursts, minutes late.
     */
    private static void pump(InputStream from, OutputStream to) {
        byte[] chunk = new byte[8192];
        try {
            int n;
            while ((n = from.read(chunk)) != -1) {
                to.write(chunk, 0, n);
                to.flush();
            }
        } catch (IOException ignored) {
            // Either side hanging up is the normal end of a stream here.
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) out.write(chunk, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static int indexOfLineEnd(String text) {
        int i = text.indexOf("\r\n");
        return i < 0 ? text.length() : i;
    }

    private static String[] splitAll(String headText) {
        return headText.split("\r\n", -1);
    }

    /** Header lines only — the request line and the trailing blank dropped. */
    private static String[] splitHeaderLines(String headText) {
        String[] all = splitAll(headText);
        String[] out = new String[Math.max(0, all.length - 1)];
        System.arraycopy(all, 1, out, 0, out.length);
        return out;
    }

    private static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }
}

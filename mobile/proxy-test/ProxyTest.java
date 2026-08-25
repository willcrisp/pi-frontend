package dev.radius.mobile;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLServerSocketFactory;
import java.security.KeyStore;

/**
 * Off-device test for LocalProxy.
 *
 * <p>LocalProxy is the riskiest file in the Android port: it is the only new
 * native code, every request in the app goes through it, and a bug in it looks
 * from the phone like "the app doesn't work" with no stack trace. So it is
 * written free of Android imports and tested here against a real upstream
 * instead of being shipped on inspection alone.
 *
 * <p>Run it against the repo's mock server:
 *
 * <pre>
 *   MOCK_PORT=4097 node test/mock-opencode.js &amp;
 *   javac -d /tmp/pt android/app/src/main/java/dev/radius/mobile/LocalProxy.java \
 *         mobile/proxy-test/ProxyTest.java
 *   java -cp /tmp/pt dev.radius.mobile.ProxyTest 4097
 * </pre>
 */
public class ProxyTest {

    private static int failures = 0;

    public static void main(String[] args) throws Exception {
        int upstream = args.length > 0 ? Integer.parseInt(args[0]) : 4097;

        LocalProxy proxy = new LocalProxy(path -> {
            if (path.equals("public/index.html")) {
                return new ByteArrayInputStream("<!doctype html><title>radius</title>".getBytes(StandardCharsets.UTF_8));
            }
            if (path.equals("public/assets/app.js")) {
                return new ByteArrayInputStream("export const x = 1;".getBytes(StandardCharsets.UTF_8));
            }
            throw new IOException("no such asset " + path);
        });
        proxy.start();
        Thread.sleep(300);

        // ── Assets ──────────────────────────────────────────────────────────
        String root = request("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("index.html served at /", root.contains("200 OK") && root.contains("<title>radius</title>"));
        check("index.html gets an html content-type", root.contains("Content-Type: text/html"));

        String js = request("GET /assets/app.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("js asset served", js.contains("export const x = 1;"));
        check("js gets a js content-type", js.contains("text/javascript"));

        // ── Proxying ────────────────────────────────────────────────────────
        String health = request("GET /api/http/127.0.0.1:" + upstream + "/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("proxied GET reaches upstream", health.contains("{\"ok\":true}"));

        // The prefix's host part is optional and defaults to loopback, which is
        // the older form the desktop app used. Both must keep working.
        // Every part of the prefix is mandatory now — a malformed one must not
        // silently fall back to some default target, it must miss the proxy rule
        // and be treated as an asset path.
        String noScheme = request("GET /api/127.0.0.1:" + upstream + "/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("a prefix without a scheme is not proxied", !noScheme.contains("{\"ok\":true}"));

        String sessions = request("GET /api/http/127.0.0.1:" + upstream + "/api/session HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("proxied list route returns the data envelope", sessions.contains("\"data\""));

        String post = request(
                "POST /api/http/127.0.0.1:" + upstream + "/api/mock/control HTTP/1.1\r\n"
                        + "Host: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
        check("proxied POST body reaches upstream", post.contains("application/json") && !post.contains("<!doctype"));

        check("Origin header is not forwarded", !upstreamSawOrigin(upstream));

        // Against a stub rather than the mock server, which answers 200 on
        // unknown routes — that would test the mock's routing, not the proxy's
        // status passthrough.
        Thread notFound = serveOnce(48114, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        notFound.start();
        Thread.sleep(200);
        String missing = request("GET /api/http/127.0.0.1:48114/api/nope HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("upstream 404 passes through as a 404", missing.startsWith("HTTP/1.1 404"));

        String dead = request("GET /api/http/127.0.0.1:1/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("unreachable upstream answers 502, not a dropped socket", dead.startsWith("HTTP/1.1 502"));

        // ── The 401 challenge ───────────────────────────────────────────────
        // The header that hangs a WebView must not survive the proxy.
        Thread challenge = serveOnce(48111,
                "HTTP/1.1 401 Unauthorized\r\n"
                        + "WWW-Authenticate: Basic realm=\"Secure Area\"\r\n"
                        + "Content-Length: 0\r\n\r\n");
        challenge.start();
        Thread.sleep(200);
        String unauth = request("GET /api/http/127.0.0.1:48111/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        check("401 still arrives as a 401", unauth.startsWith("HTTP/1.1 401"));
        check("WWW-Authenticate is stripped", !unauth.toLowerCase().contains("www-authenticate"));

        // ── Streaming ───────────────────────────────────────────────────────
        // The SSE stream is how every message in the app arrives. If the proxy
        // buffers it, the app looks dead until enough bytes pile up.
        check("SSE events arrive incrementally, not buffered", ssePassesThrough(upstream));

        // ── WebSocket upgrade (the PTY routes) ──────────────────────────────
        Thread ws = serveOnce(48112,
                "HTTP/1.1 101 Switching Protocols\r\n"
                        + "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\nFRAME");
        ws.start();
        Thread.sleep(200);
        String upgraded = request(
                "GET /api/http/127.0.0.1:48112/api/pty/x/connect HTTP/1.1\r\n"
                        + "Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        check("101 passes through", upgraded.startsWith("HTTP/1.1 101"));
        check("101 keeps Connection: Upgrade", upgraded.toLowerCase().contains("connection: upgrade"));
        check("bytes after the 101 are spliced through", upgraded.contains("FRAME"));

        // ── TLS upstream (a Coder port-forward URL) ─────────────────────────
        // Against a real HTTPS server with a self-signed cert. The test JVM
        // trusts it via -Djavax.net.ssl.trustStore; see docs/android.md.
        if (System.getProperty("test.keyStore") != null) {
            String goodStore = System.getProperty("test.keyStore");
            String wrongStore = System.getProperty("test.wrongKeyStore");
            Thread tls = serveTlsOnce(48120, "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nsecured", goodStore);
            tls.start();
            Thread.sleep(400);
            String over = request("GET /api/https/localhost:48120/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            check("https upstream: handshake succeeds and the body comes through", over.contains("secured"));

            // A server on localhost presenting a certificate issued for a
            // completely different name. If this succeeds, hostname verification
            // is off and ANY certificate for ANY name would be accepted — which
            // is most of the point of TLS gone, silently. This is the check that
            // caught the wrapped-socket default during development.
            Thread tls2 = serveTlsOnce(48121, "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nsecured", wrongStore);
            tls2.start();
            Thread.sleep(400);
            String wrongName = request("GET /api/https/localhost:48121/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            check("https upstream: a cert for the wrong hostname is rejected",
                    wrongName.startsWith("HTTP/1.1 502") && !wrongName.contains("secured"));

            // Plain http to a TLS port must not be mistaken for success.
            String plainToTls = request("GET /api/http/localhost:48122/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            check("http to a dead port still answers 502", plainToTls.startsWith("HTTP/1.1 502"));
        } else {
            System.out.println("  SKIP  https upstream checks (no -Djavax.net.ssl.trustStore)");
        }

        proxy.stop();
        System.out.println(failures == 0 ? "\nALL PASSED" : "\n" + failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }

    /** Reads the stream for a moment and reports whether events arrived separately. */
    private static boolean ssePassesThrough(int upstream) throws Exception {
        try (Socket s = new Socket("127.0.0.1", LocalProxy.PORT)) {
            s.getOutputStream().write(
                    ("GET /api/http/127.0.0.1:" + upstream + "/api/event HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n")
                            .getBytes(StandardCharsets.ISO_8859_1));
            s.getOutputStream().flush();
            s.setSoTimeout(4000);
            InputStream in = s.getInputStream();
            StringBuilder seen = new StringBuilder();
            byte[] buf = new byte[4096];
            long deadline = System.currentTimeMillis() + 3500;
            while (System.currentTimeMillis() < deadline) {
                try {
                    int n = in.read(buf);
                    if (n == -1) break;
                    seen.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                    // Got the head plus at least one event without the stream
                    // having to close first — that is what "not buffered" means.
                    if (seen.indexOf("data:") >= 0) return true;
                } catch (IOException timeout) {
                    break;
                }
            }
            return seen.indexOf("data:") >= 0;
        }
    }

    /** Confirms no Origin reaches upstream, by having a stub echo what it got. */
    private static boolean upstreamSawOrigin(int unusedUpstream) throws Exception {
        final StringBuilder got = new StringBuilder();
        Thread echo = new Thread(() -> {
            try (java.net.ServerSocket ss = new java.net.ServerSocket(48113)) {
                Socket c = ss.accept();
                InputStream in = c.getInputStream();
                byte[] buf = new byte[4096];
                int n = in.read(buf);
                got.append(new String(buf, 0, Math.max(n, 0), StandardCharsets.ISO_8859_1));
                c.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".getBytes(StandardCharsets.ISO_8859_1));
                c.getOutputStream().flush();
                Thread.sleep(100);
                c.close();
            } catch (Exception ignored) {
            }
        });
        echo.start();
        Thread.sleep(200);
        request("GET /api/http/127.0.0.1:48113/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1:47653\r\n\r\n");
        echo.join(2000);
        return got.toString().toLowerCase().contains("origin:");
    }

    /** A one-shot HTTPS server using the given PKCS12 keystore. */
    private static Thread serveTlsOnce(int port, String response, String keyStore) {
        return new Thread(() -> {
            try {
                KeyStore ks = KeyStore.getInstance("PKCS12");
                try (InputStream in = new java.io.FileInputStream(keyStore)) {
                    ks.load(in, "changeit".toCharArray());
                }
                KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
                kmf.init(ks, "changeit".toCharArray());
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(kmf.getKeyManagers(), null, null);
                SSLServerSocketFactory f = ctx.getServerSocketFactory();
                try (SSLServerSocket ss = (SSLServerSocket) f.createServerSocket(port)) {
                    Socket c = ss.accept();
                    c.getInputStream().read(new byte[4096]);
                    c.getOutputStream().write(response.getBytes(StandardCharsets.ISO_8859_1));
                    c.getOutputStream().flush();
                    Thread.sleep(300);
                    c.close();
                }
            } catch (Exception ignored) {
            }
        });
    }

    private static Thread serveOnce(int port, String response) {
        return new Thread(() -> {
            try (java.net.ServerSocket ss = new java.net.ServerSocket(port)) {
                Socket c = ss.accept();
                c.getInputStream().read(new byte[4096]);
                OutputStream out = c.getOutputStream();
                out.write(response.getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                Thread.sleep(300);
                c.close();
            } catch (Exception ignored) {
            }
        });
    }

    private static String request(String raw) throws IOException {
        try (Socket s = new Socket("127.0.0.1", LocalProxy.PORT)) {
            s.setSoTimeout(5000);
            s.getOutputStream().write(raw.getBytes(StandardCharsets.ISO_8859_1));
            s.getOutputStream().flush();
            StringBuilder out = new StringBuilder();
            byte[] buf = new byte[8192];
            InputStream in = s.getInputStream();
            try {
                int n;
                while ((n = in.read(buf)) != -1) out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            } catch (IOException timeout) {
                /* whatever arrived is the answer */
            }
            return out.toString();
        }
    }

    private static void check(String label, boolean ok) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + label);
        if (!ok) failures++;
    }
}

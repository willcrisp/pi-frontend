package dev.radius.mobile;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Watches the opencode2 event stream from outside the WebView, so the phone can
 * be told what happened while the app was closed.
 *
 * <p>WHY THIS IS NATIVE. Android freezes a backgrounded WebView. The app's own
 * SSE connection dies with it and no JavaScript runs again until you reopen the
 * app — which is precisely when a notification would no longer be useful. So the
 * watching has to happen somewhere the system keeps alive, which means a
 * foreground service, which means this logic cannot live in the web app.
 *
 * <p>DELIBERATELY FREE OF ANDROID IMPORTS, like {@link LocalProxy} and for the
 * same reason: a background service that quietly fails to notify is close to
 * undebuggable on a device. Everything decidable is decided here and tested
 * off-device by mobile/proxy-test/WatcherTest.java; {@code NotificationService}
 * is glue that turns {@link Listener} calls into system notifications.
 *
 * <p>The run-end rule is copied from {@code stores/opencode/run.js} and must stay
 * in step with it. The short version, which that file explains at length: **no
 * event reliably says a run finished**. A terminal event is a candidate, and
 * {@code GET /session/active} is the only authority — a steered prompt keeps the
 * same agent loop going past a {@code step.ended}, so obeying one would announce
 * "finished" in the middle of a turn.
 */
public class EventWatcher implements Runnable {

    /** What the service turns into notifications. Called off the main thread. */
    public interface Listener {
        /**
         * @param kind  one of {@link #KIND_PERMISSION}, {@link #KIND_QUESTION},
         *              {@link #KIND_FINISHED} — the caller maps these to channels
         *              and importance.
         * @param title short line, already human-readable
         * @param body  the session's title where known, else its id
         * @param tag   stable per session+kind, so a repeat replaces rather than
         *              stacks
         */
        void onNotify(String kind, String title, String body, String tag);

        /** Connection state, for the service's own ongoing notification. */
        void onConnectionChange(boolean connected);
    }

    public static final String KIND_PERMISSION = "permission";
    public static final String KIND_QUESTION = "question";
    public static final String KIND_FINISHED = "finished";

    /** Mirrors RUN_END_EVENTS in stores/opencode/run.js. */
    private static final Set<String> RUN_END_EVENTS = new HashSet<>(Arrays.asList(
            "session.idle",
            "session.execution.succeeded",
            "session.execution.completed",
            "session.execution.failed",
            "session.execution.aborted",
            "session.execution.cancelled",
            "session.aborted",
            "session.error",
            "session.step.failed"));

    /** Wait after a terminal event before asking whether the run really ended.
     *  Also coalesces the burst some builds send at the end of a turn. */
    private static final long CONFIRM_MS = 600;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    /** Reconnect backoff bounds. A phone loses its network constantly; a tight
     *  retry loop would be a battery bug rather than a feature. */
    private static final long RETRY_MIN_MS = 2000;
    private static final long RETRY_MAX_MS = 60000;

    private final String baseUrl; // e.g. https://host:443/api
    private final String authHeader; // may be null
    private final Listener listener;

    private volatile boolean running = true;
    /** Set by the app: no notifications while the user is looking at the app. */
    private volatile boolean appVisible = true;
    /** Sessions believed mid-turn, so a terminal event can be attributed. */
    private final Set<String> active = new LinkedHashSet<>();
    /** sessionID -> title, filled lazily; avoids a request per notification. */
    private final Map<String, String> titles = new HashMap<>();
    /** sessionID -> is a dispatched sub-agent. A child finishing is not "your
     *  turn finished" — the parent loop is still going. */
    private final Map<String, Boolean> isChild = new HashMap<>();
    private volatile long lastSessionLoad = 0;
    /** How stale the title/sub-agent maps may get. A new session's title is
     *  written by the server a moment after its first prompt, so this is short. */
    private static final long SESSION_CACHE_MS = 10000;

    public EventWatcher(String scheme, String host, int port, String authHeader, Listener listener) {
        this.baseUrl = scheme + "://" + host + ":" + port + "/api";
        this.authHeader = authHeader;
        this.listener = listener;
    }

    public void stop() {
        running = false;
    }

    public void setAppVisible(boolean visible) {
        appVisible = visible;
    }

    @Override
    public void run() {
        long backoff = RETRY_MIN_MS;
        while (running) {
            try {
                streamOnce();
                backoff = RETRY_MIN_MS; // a clean end means the connection worked
            } catch (Exception e) {
                listener.onConnectionChange(false);
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                return;
            }
            backoff = Math.min(backoff * 2, RETRY_MAX_MS);
        }
    }

    // ── The stream ──────────────────────────────────────────────────────────

    private void streamOnce() throws IOException {
        HttpURLConnection conn = open("/event");
        conn.setReadTimeout(0); // the stream is meant to stay open
        try (InputStream in = conn.getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            listener.onConnectionChange(true);
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        handle(data.toString());
                        data.setLength(0);
                    }
                    continue;
                }
                // Only `data:` matters here; SSE's id/event/retry fields are
                // unused by this server.
                if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                }
            }
        } finally {
            conn.disconnect();
            listener.onConnectionChange(false);
        }
    }

    /** Visible for testing: process one SSE payload. */
    void handle(String payload) {
        Map<String, Object> event = Json.parseObject(payload);
        String type = canonical(Json.str(event, "type"));
        if (type == null) return;
        Map<String, Object> props = Json.asMap(Json.get(event, "data"));
        String sessionID = str(props, "sessionID");

        // The two that block an agent outright. No confirmation needed: they are
        // unambiguous, and they are the notifications that actually matter —
        // an approval nobody sees stalls the run indefinitely.
        if (type.equals("permission.v2.asked")) {
            notifyFor(KIND_PERMISSION, "Approval needed", sessionID);
            return;
        }
        if (type.equals("question.v2.asked")) {
            notifyFor(KIND_QUESTION, "The agent has a question", sessionID);
            return;
        }

        if (sessionID == null) return;

        // Anything that says a turn is under way marks the session live, so a
        // later terminal event has something to attribute itself to.
        if (type.startsWith("session.") && !isRunEndEvent(type, props)) {
            if (type.contains("step.started") || type.contains("prompted") || type.contains("admitted")) {
                active.add(sessionID);
            }
        }

        if (isRunEndEvent(type, props)) confirmEnded(sessionID);
    }

    /** Mirrors isRunEndEvent() in stores/opencode/run.js. */
    static boolean isRunEndEvent(String type, Map<String, Object> props) {
        if (RUN_END_EVENTS.contains(type)) return true;
        if (type.equals("session.step.ended")) {
            // A step ending is the end of the turn only when the model stopped,
            // rather than handing back tool calls for another step.
            String finish = props == null ? null : str(props, "finish");
            return finish != null && !finish.equals("tool-calls");
        }
        return false;
    }

    /** `session.next.foo` and `session.foo` are one event under two builds' names. */
    static String canonical(String type) {
        if (type == null) return null;
        return type.startsWith("session.next.") ? "session." + type.substring(13) : type;
    }

    // ── Confirming an ending ────────────────────────────────────────────────

    private void confirmEnded(String sessionID) {
        if (!active.contains(sessionID)) return; // never saw it start
        try {
            Thread.sleep(CONFIRM_MS);
        } catch (InterruptedException e) {
            return;
        }
        if (!running) return;
        if (stillRunning(sessionID)) return; // a steered prompt kept the loop going
        active.remove(sessionID);
        if (isSubagent(sessionID)) return; // a child ending is not the turn ending
        notifyFor(KIND_FINISHED, "Turn finished", sessionID);
    }

    /**
     * GET /session/active — every session whose agent loop is running right now.
     * A build without the route is treated as "not running": trusting the
     * terminal event is the same degradation run.js makes, and the cost of being
     * wrong here is one early notification rather than a stuck UI.
     */
    private boolean stillRunning(String sessionID) {
        String body = get("/session/active");
        if (body == null) return false;
        Map<String, Object> data = Json.asMap(Json.get(Json.parseObject(body), "data"));
        return data.containsKey(sessionID);
    }

    private boolean isSubagent(String sessionID) {
        Boolean known = isChild.get(sessionID);
        if (known == null) {
            loadSessions();
            known = isChild.get(sessionID);
        }
        return known != null && known;
    }

    /**
     * Fill the title and sub-agent maps from GET /session.
     *
     * <p>The list rather than GET /session/{id}: one request covers every
     * session, it carries both fields this needs, and it is a route the app
     * itself depends on — a per-id route is not guaranteed across builds (the
     * repo's own mock server does not implement one).
     *
     * <p>Rate-limited because it is called on a cache miss, and a burst of
     * events for an unknown session would otherwise mean a burst of requests.
     */
    private void loadSessions() {
        long now = System.currentTimeMillis();
        if (now - lastSessionLoad < SESSION_CACHE_MS) return;
        lastSessionLoad = now;

        String body = get("/session");
        if (body == null) return;
        Object data = Json.get(Json.parseObject(body), "data");
        if (!(data instanceof java.util.List)) return;
        for (Object item : (java.util.List<?>) data) {
            Map<String, Object> s = Json.asMap(item);
            String id = str(s, "id");
            if (id == null) continue;
            String title = str(s, "title");
            if (title != null && !title.isEmpty()) titles.put(id, title);
            String parent = str(s, "parentID");
            isChild.put(id, parent != null && !parent.isEmpty());
        }
    }

    private void notifyFor(String kind, String title, String sessionID) {
        // The user is looking at the app; the UI already shows all of this.
        if (appVisible) return;
        String body = sessionID == null ? "" : titles.get(sessionID);
        if (body == null && sessionID != null) {
            loadSessions();
            body = titles.get(sessionID);
        }
        if (body == null) body = "a chat";
        listener.onNotify(kind, title, body, kind + ":" + sessionID);
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    private HttpURLConnection open(String path) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setRequestProperty("Accept", "text/event-stream");
        if (authHeader != null) conn.setRequestProperty("Authorization", authHeader);
        // HttpsURLConnection verifies the chain and the hostname by default, so
        // unlike LocalProxy's wrapped socket there is nothing to switch on here.
        return conn;
    }

    private String get(String path) {
        HttpURLConnection conn = null;
        try {
            conn = open(path);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() / 100 != 2) return null;
            try (InputStream in = conn.getInputStream()) {
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                return sb.toString();
            }
        } catch (IOException e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String str(Map<String, Object> map, String key) {
        Object v = map == null ? null : map.get(key);
        return v instanceof String ? (String) v : null;
    }
}

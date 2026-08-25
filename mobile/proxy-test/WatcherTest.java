package dev.radius.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Off-device tests for {@link EventWatcher} and {@link Json}.
 *
 * <p>A background service that silently fails to notify is close to undebuggable
 * on a phone: there is no console, and "it didn't buzz" is the only symptom for
 * a dozen different causes. So the decisions live in plain Java and are asserted
 * here instead.
 *
 * <pre>
 *   MOCK_PORT=4097 node test/mock-opencode.js &amp;
 *   javac -d /tmp/pt android/app/src/main/java/dev/radius/mobile/*.java mobile/proxy-test/*.java
 *   java -cp /tmp/pt dev.radius.mobile.WatcherTest 4097
 * </pre>
 */
public class WatcherTest {

    private static int failures = 0;

    static class Captured {
        final List<String> kinds = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();
    }

    public static void main(String[] args) throws Exception {
        int upstream = args.length > 0 ? Integer.parseInt(args[0]) : 4097;

        // ── Json ────────────────────────────────────────────────────────────
        // The reason this parser exists rather than a regex: an assistant's own
        // text streams through it, and a model writing about this codebase emits
        // exactly the bytes a regex would match. Anything that ignores string
        // boundaries eventually fires a notification because the agent typed one.
        Map<String, Object> tricky = Json.parseObject(
                "{\"type\":\"session.text.delta\",\"data\":{\"text\":\"the event is \\\"type\\\":\\\"session.idle\\\" here\"}}");
        check("Json: nested quotes don't leak into the outer object",
                "session.text.delta".equals(Json.str(tricky, "type")));
        check("Json: escaped quotes survive inside the string",
                ((String) Json.get(tricky, "data", "text")).contains("\"type\":\"session.idle\""));
        check("Json: dotted lookup reaches nested fields",
                "abc".equals(Json.str(Json.parseObject("{\"data\":{\"sessionID\":\"abc\"}}"), "data", "sessionID")));
        check("Json: malformed payload yields an empty map, not a crash",
                Json.parseObject("{\"broken\":").isEmpty());
        check("Json: unicode escapes decode",
                "\u2713".equals(Json.str(Json.parseObject("{\"a\":\"\\u2713\"}"), "a")));

        // ── The run-end rule, copied from run.js ────────────────────────────
        check("run-end: step.ended with finish=stop is terminal",
                EventWatcher.isRunEndEvent("session.step.ended", Json.asMap(Json.get(
                        Json.parseObject("{\"d\":{\"finish\":\"stop\"}}"), "d"))));
        check("run-end: step.ended with finish=tool-calls is NOT terminal",
                !EventWatcher.isRunEndEvent("session.step.ended", Json.asMap(Json.get(
                        Json.parseObject("{\"d\":{\"finish\":\"tool-calls\"}}"), "d"))));
        check("run-end: step.ended with no finish is NOT terminal",
                !EventWatcher.isRunEndEvent("session.step.ended", Json.parseObject("{}")));
        check("run-end: session.idle is terminal",
                EventWatcher.isRunEndEvent("session.idle", Json.parseObject("{}")));
        check("run-end: a text delta is not terminal",
                !EventWatcher.isRunEndEvent("session.text.delta", Json.parseObject("{}")));

        check("canonical: session.next.* normalizes to session.*",
                "session.step.ended".equals(EventWatcher.canonical("session.next.step.ended")));
        check("canonical: an already-canonical type is untouched",
                "session.idle".equals(EventWatcher.canonical("session.idle")));
        check("canonical: a non-session type is untouched",
                "permission.v2.asked".equals(EventWatcher.canonical("permission.v2.asked")));

        // ── What actually gets notified ─────────────────────────────────────
        Captured c = new Captured();
        EventWatcher w = watcher(upstream, c);
        w.setAppVisible(false);

        // A blocked agent is the notification that matters most: an approval
        // nobody sees stalls the run forever.
        w.handle("{\"type\":\"permission.v2.asked\",\"data\":{\"id\":\"p1\",\"sessionID\":\"ses_mock1\",\"action\":\"bash\"}}");
        check("notifies on a permission ask", c.kinds.contains(EventWatcher.KIND_PERMISSION));

        w.handle("{\"type\":\"question.v2.asked\",\"data\":{\"id\":\"q1\",\"sessionID\":\"ses_mock1\",\"questions\":[{\"question\":\"which?\"}]}}");
        check("notifies on a question", c.kinds.contains(EventWatcher.KIND_QUESTION));

        check("the session's real title is used as the body",
                c.bodies.stream().anyMatch(b -> b != null && !b.equals("a chat")));

        // A terminal event for a session that was never seen running must not
        // announce anything — that is the burst-at-startup case.
        int before = c.kinds.size();
        w.handle("{\"type\":\"session.step.ended\",\"data\":{\"sessionID\":\"ses_never\",\"finish\":\"stop\"}}");
        check("a terminal event for an unseen session notifies nothing", c.kinds.size() == before);

        // Text the agent wrote that happens to look like a terminal event.
        before = c.kinds.size();
        w.handle("{\"type\":\"session.next.text.delta\",\"data\":{\"sessionID\":\"ses_mock1\","
                + "\"text\":\"then it sends \\\"type\\\":\\\"session.idle\\\" and stops\"}}");
        check("an agent writing about session.idle notifies nothing", c.kinds.size() == before);

        // Not while the app is on screen — the UI already shows all of it.
        w.setAppVisible(true);
        before = c.kinds.size();
        w.handle("{\"type\":\"permission.v2.asked\",\"data\":{\"id\":\"p2\",\"sessionID\":\"ses_mock1\"}}");
        check("silent while the app is in the foreground", c.kinds.size() == before);

        // ── The live stream ─────────────────────────────────────────────────
        // Everything above drives handle() directly, which leaves the part that
        // actually reads the socket untested — SSE framing, the data: prefix, the
        // blank-line terminator, reconnects. So run the real loop against the
        // mock server and push an event through it.
        Captured live = new Captured();
        EventWatcher streaming = watcher(upstream, live);
        streaming.setAppVisible(false);
        Thread t = new Thread(streaming, "watcher-under-test");
        t.setDaemon(true);
        t.start();
        Thread.sleep(1500); // let it connect

        emit(upstream, "{\"type\":\"permission.v2.asked\",\"data\":"
                + "{\"id\":\"live1\",\"sessionID\":\"ses_mock1\",\"action\":\"bash\"}}");

        long deadline = System.currentTimeMillis() + 6000;
        while (live.kinds.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(100);
        check("a permission ask arriving over the real SSE stream is notified",
                live.kinds.contains(EventWatcher.KIND_PERMISSION));
        check("the notification body is the session's title",
                live.bodies.contains("Mock session"));
        streaming.stop();

        System.out.println(failures == 0 ? "\nALL PASSED" : "\n" + failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }

    /** Push an event through the mock server's own emit hook. */
    private static void emit(int port, String json) throws Exception {
        java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
                new java.net.URL("http://127.0.0.1:" + port + "/api/mock/emit").openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.getOutputStream().write(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        conn.getInputStream().close();
        conn.disconnect();
    }

    private static EventWatcher watcher(int port, Captured c) {
        return new EventWatcher("http", "127.0.0.1", port, null, new EventWatcher.Listener() {
            @Override
            public void onNotify(String kind, String title, String body, String tag) {
                c.kinds.add(kind);
                c.bodies.add(body);
            }

            @Override
            public void onConnectionChange(boolean connected) {}
        });
    }

    private static void check(String label, boolean ok) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + label);
        if (!ok) failures++;
    }
}

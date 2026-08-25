package dev.radius.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader, enough to pull named fields out of an SSE payload.
 *
 * <p>Android ships org.json, but using it would tie {@link EventWatcher} to the
 * platform and put its logic beyond off-device testing — which for this app is
 * the difference between a bug found in a second and a bug found by noticing the
 * phone never buzzed.
 *
 * <p>The obvious shortcut, a regex for {@code "type":"…"}, is not safe here: an
 * assistant's own text streams through this parser, and a model writing about
 * this codebase would produce exactly those bytes inside a string. Anything that
 * does not respect string boundaries will eventually fire a notification because
 * the agent typed one.
 *
 * <p>Values come back as String, Double, Boolean, null, {@code Map<String,Object>}
 * or {@code List<Object>}.
 */
final class Json {

    private final String src;
    private int at;

    private Json(String src) {
        this.src = src;
    }

    /** Parse an object; returns an empty map on anything malformed. */
    static Map<String, Object> parseObject(String text) {
        if (text == null) return new LinkedHashMap<>();
        try {
            Json j = new Json(text);
            j.skipWhitespace();
            Object v = j.value();
            return v instanceof Map ? asMap(v) : new LinkedHashMap<>();
        } catch (RuntimeException e) {
            // A truncated or unexpected payload is not worth a crash in a
            // background service; it just isn't a notification.
            return new LinkedHashMap<>();
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>();
    }

    /** Dotted lookup: {@code get(root, "data", "sessionID")}. Null if absent. */
    static Object get(Map<String, Object> root, String... path) {
        Object cur = root;
        for (String key : path) {
            if (!(cur instanceof Map)) return null;
            cur = ((Map<?, ?>) cur).get(key);
        }
        return cur;
    }

    static String str(Map<String, Object> root, String... path) {
        Object v = get(root, path);
        return v instanceof String ? (String) v : null;
    }

    // ── Parsing ─────────────────────────────────────────────────────────────

    private Object value() {
        char c = peek();
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': expect("true"); return Boolean.TRUE;
            case 'f': expect("false"); return Boolean.FALSE;
            case 'n': expect("null"); return null;
            default: return number();
        }
    }

    private Map<String, Object> object() {
        Map<String, Object> out = new LinkedHashMap<>();
        at++; // {
        skipWhitespace();
        if (peek() == '}') { at++; return out; }
        while (true) {
            skipWhitespace();
            String key = string();
            skipWhitespace();
            at++; // :
            skipWhitespace();
            out.put(key, value());
            skipWhitespace();
            char c = src.charAt(at++);
            if (c == '}') return out;
            if (c != ',') throw new IllegalStateException("expected , or } at " + at);
        }
    }

    private List<Object> array() {
        List<Object> out = new ArrayList<>();
        at++; // [
        skipWhitespace();
        if (peek() == ']') { at++; return out; }
        while (true) {
            skipWhitespace();
            out.add(value());
            skipWhitespace();
            char c = src.charAt(at++);
            if (c == ']') return out;
            if (c != ',') throw new IllegalStateException("expected , or ] at " + at);
        }
    }

    private String string() {
        StringBuilder sb = new StringBuilder();
        at++; // opening quote
        while (true) {
            char c = src.charAt(at++);
            if (c == '"') return sb.toString();
            if (c != '\\') { sb.append(c); continue; }
            char esc = src.charAt(at++);
            switch (esc) {
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case '/': sb.append('/'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'u':
                    sb.append((char) Integer.parseInt(src.substring(at, at + 4), 16));
                    at += 4;
                    break;
                default: throw new IllegalStateException("bad escape \\" + esc);
            }
        }
    }

    private Double number() {
        int start = at;
        while (at < src.length() && "+-.eE0123456789".indexOf(src.charAt(at)) >= 0) at++;
        return Double.valueOf(src.substring(start, at));
    }

    private void expect(String word) {
        if (!src.startsWith(word, at)) throw new IllegalStateException("expected " + word);
        at += word.length();
    }

    private char peek() {
        return src.charAt(at);
    }

    private void skipWhitespace() {
        while (at < src.length() && Character.isWhitespace(src.charAt(at))) at++;
    }
}

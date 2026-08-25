package dev.radius.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.io.IOException;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    private LocalProxy proxy;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // BEFORE super.onCreate, which is where the bridge loads server.url. If
        // the proxy isn't listening by then the WebView gets a connection refused
        // and shows an error page instead of the app — with no retry.
        proxy = new LocalProxy(path -> getAssets().open(path));
        proxy.setControlHandler(this::onControl);
        try {
            proxy.start();
        } catch (IOException e) {
            // Nothing useful to fall back to: without the proxy there is no app
            // to show and no way to reach a server. Let it surface in logcat.
            throw new IllegalStateException("could not start the local proxy on port " + LocalProxy.PORT, e);
        }

        super.onCreate(savedInstanceState);

        // The transcript scrolls a long way and Android's default overscroll glow
        // fires on every message. Nothing else in the app uses it.
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        requestNotificationPermission();
    }

    /**
     * The web app's calls into native code, delivered through the proxy rather
     * than a Capacitor bridge — see LocalProxy.ControlHandler for why.
     *
     * <p>Runs on a proxy worker thread, so it does no UI work; starting a service
     * is safe from any thread.
     */
    private String onControl(String path, String body) {
        Map<String, Object> args = Json.parseObject(body);
        switch (path) {
            case "/_radius/watch": {
                // The connection the web app is actually using. Passing it here
                // rather than having native code read localStorage keeps one
                // source of truth for where the server is.
                Intent intent = new Intent(this, NotificationService.class)
                        .setAction(NotificationService.ACTION_START)
                        .putExtra(NotificationService.EXTRA_SCHEME, string(args, "scheme", "http"))
                        .putExtra(NotificationService.EXTRA_HOST, string(args, "host", ""))
                        .putExtra(NotificationService.EXTRA_PORT, (int) number(args, "port", 4096))
                        .putExtra(NotificationService.EXTRA_AUTH, string(args, "auth", null))
                        .putExtra(NotificationService.EXTRA_VISIBLE, bool(args, "visible", true));
                NotificationService.send(this, intent);
                return "{\"watching\":true}";
            }
            case "/_radius/visibility": {
                NotificationService.send(this, new Intent(this, NotificationService.class)
                        .setAction(NotificationService.ACTION_VISIBILITY)
                        .putExtra(NotificationService.EXTRA_VISIBLE, bool(args, "visible", true)));
                return "{\"ok\":true}";
            }
            case "/_radius/stop": {
                NotificationService.send(this, new Intent(this, NotificationService.class)
                        .setAction(NotificationService.ACTION_STOP));
                return "{\"ok\":true}";
            }
            default:
                return null; // 404
        }
    }

    /**
     * Android 13+ makes notifications a runtime permission. Asked for on launch
     * rather than up front in a dialog of our own: there is nothing useful to
     * explain beyond what the system prompt already says, and a declined
     * permission costs only the notifications — everything else still works.
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1001);
    }

    @Override
    public void onDestroy() {
        if (proxy != null) proxy.stop();
        // The watcher is deliberately NOT stopped here: outliving the activity is
        // the entire point. It stops when the web app says so, or when the user
        // swipes the ongoing notification's app away.
        super.onDestroy();
    }

    private static String string(Map<String, Object> args, String key, String fallback) {
        Object v = args.get(key);
        return v instanceof String ? (String) v : fallback;
    }

    private static double number(Map<String, Object> args, String key, double fallback) {
        Object v = args.get(key);
        return v instanceof Double ? (Double) v : fallback;
    }

    private static boolean bool(Map<String, Object> args, String key, boolean fallback) {
        Object v = args.get(key);
        return v instanceof Boolean ? (Boolean) v : fallback;
    }
}

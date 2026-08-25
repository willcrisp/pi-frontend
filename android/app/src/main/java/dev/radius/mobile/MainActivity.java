package dev.radius.mobile;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.io.IOException;

public class MainActivity extends BridgeActivity {

    private LocalProxy proxy;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // BEFORE super.onCreate, which is where the bridge loads server.url. If
        // the proxy isn't listening by then the WebView gets a connection refused
        // and shows an error page instead of the app — with no retry.
        proxy = new LocalProxy(path -> getAssets().open(path));
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
    }

    @Override
    public void onDestroy() {
        if (proxy != null) proxy.stop();
        super.onDestroy();
    }
}

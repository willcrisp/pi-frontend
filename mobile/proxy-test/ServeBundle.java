package dev.radius.mobile;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * Runs LocalProxy over the real bundled assets, so the production build can be
 * driven in a browser exactly as the APK will serve it — same proxy, same
 * bundle, same URL shape. The only thing left untested after this is the WebView
 * itself.
 *
 * <pre>java -cp /tmp/pt dev.radius.mobile.ServeBundle android/app/src/main/assets</pre>
 */
public class ServeBundle {
    public static void main(String[] args) throws Exception {
        File root = new File(args.length > 0 ? args[0] : "android/app/src/main/assets");
        LocalProxy proxy = new LocalProxy(path -> {
            File f = new File(root, path);
            if (!f.isFile()) throw new IOException("no such asset " + path);
            return new FileInputStream(f);
        });
        // Stands in for MainActivity's control handler, so the JS side of the
        // native-watch contract can be exercised in a browser: every call the app
        // makes is echoed here, which is how the payload it sends is checked
        // against what NotificationService expects.
        proxy.setControlHandler((path, body) -> {
            System.out.println("CONTROL " + path + " " + body);
            return "{\"ok\":true}";
        });
        proxy.start();
        System.out.println("serving " + root + " on http://127.0.0.1:" + LocalProxy.PORT);
        Thread.sleep(Long.MAX_VALUE);
    }
}

package dev.radius.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Keeps {@link EventWatcher} alive while the app is backgrounded, and turns what
 * it reports into system notifications.
 *
 * <p>A foreground service is the only way to hold a connection open on modern
 * Android: a backgrounded WebView is frozen, and a plain background thread is
 * killed. The cost is the ongoing notification the system requires in return,
 * which is put on a MIN-importance channel so it sits silently in the shade
 * rather than buzzing.
 *
 * <p>Everything decidable lives in {@link EventWatcher}, which has no Android
 * imports and is tested off-device. This class is glue.
 */
public class NotificationService extends Service {

    public static final String ACTION_START = "dev.radius.mobile.START_WATCH";
    public static final String ACTION_STOP = "dev.radius.mobile.STOP_WATCH";
    public static final String ACTION_VISIBILITY = "dev.radius.mobile.VISIBILITY";

    public static final String EXTRA_SCHEME = "scheme";
    public static final String EXTRA_HOST = "host";
    public static final String EXTRA_PORT = "port";
    public static final String EXTRA_AUTH = "auth";
    public static final String EXTRA_VISIBLE = "visible";

    /** Silent and collapsed: the price of a foreground service, not a message. */
    private static final String CHANNEL_ONGOING = "radius.ongoing";
    /** An agent that cannot continue until you answer. Worth interrupting for. */
    private static final String CHANNEL_BLOCKED = "radius.blocked";
    /** A turn finished. Worth knowing, not worth interrupting for. */
    private static final String CHANNEL_DONE = "radius.done";

    private static final int ONGOING_ID = 1;
    private final AtomicInteger nextId = new AtomicInteger(100);

    private EventWatcher watcher;
    private Thread thread;

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started, not bound — the app talks to it through Intents
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            stopWatching();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_VISIBILITY.equals(action)) {
            if (watcher != null) watcher.setAppVisible(intent.getBooleanExtra(EXTRA_VISIBLE, true));
            return START_STICKY;
        }

        if (ACTION_START.equals(action)) {
            // startForeground must happen promptly after the service starts, or
            // the system kills it with a ForegroundServiceDidNotStartInTime.
            startForeground(ONGOING_ID, ongoingNotification("Watching for updates"));
            restartWatcher(
                    intent.getStringExtra(EXTRA_SCHEME),
                    intent.getStringExtra(EXTRA_HOST),
                    intent.getIntExtra(EXTRA_PORT, 4096),
                    intent.getStringExtra(EXTRA_AUTH),
                    intent.getBooleanExtra(EXTRA_VISIBLE, true));
            return START_STICKY;
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWatching();
        super.onDestroy();
    }

    // ── The watcher ─────────────────────────────────────────────────────────

    private void restartWatcher(String scheme, String host, int port, String auth, boolean visible) {
        stopWatching();
        if (host == null || host.isEmpty()) return;

        watcher = new EventWatcher(scheme == null ? "http" : scheme, host, port, auth, new EventWatcher.Listener() {
            @Override
            public void onNotify(String kind, String title, String body, String tag) {
                post(kind, title, body, tag);
            }

            @Override
            public void onConnectionChange(boolean connected) {
                // Reflected in the ongoing notification rather than a new one:
                // a phone changes network constantly and each flap would
                // otherwise be an alert.
                NotificationManager nm = getSystemService(NotificationManager.class);
                if (nm != null) {
                    nm.notify(ONGOING_ID, ongoingNotification(
                            connected ? "Watching for updates" : "Reconnecting…"));
                }
            }
        });
        watcher.setAppVisible(visible);
        thread = new Thread(watcher, "radius-event-watcher");
        thread.setDaemon(true);
        thread.start();
    }

    private void stopWatching() {
        if (watcher != null) watcher.stop();
        if (thread != null) thread.interrupt();
        watcher = null;
        thread = null;
    }

    // ── Notifications ───────────────────────────────────────────────────────

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ONGOING, "Running in the background", NotificationManager.IMPORTANCE_MIN);
        ongoing.setDescription("The notice Android requires while radius watches for updates.");
        ongoing.setShowBadge(false);

        NotificationChannel blocked = new NotificationChannel(
                CHANNEL_BLOCKED, "Waiting on you", NotificationManager.IMPORTANCE_HIGH);
        blocked.setDescription("An agent has stopped and cannot continue until you answer.");

        NotificationChannel done = new NotificationChannel(
                CHANNEL_DONE, "Turn finished", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("An agent finished what it was doing.");

        nm.createNotificationChannel(ongoing);
        nm.createNotificationChannel(blocked);
        nm.createNotificationChannel(done);
    }

    private Notification ongoingNotification(String text) {
        return baseBuilder(CHANNEL_ONGOING)
                .setContentTitle("radius")
                .setContentText(text)
                .setPriority(Notification.PRIORITY_MIN)
                .setOngoing(true)
                .build();
    }

    private void post(String kind, String title, String body, String tag) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        String channel = EventWatcher.KIND_FINISHED.equals(kind) ? CHANNEL_DONE : CHANNEL_BLOCKED;
        Notification n = baseBuilder(channel)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .build();
        // Tagged per session and kind, so a second ask in the same chat replaces
        // the first instead of stacking up a column of identical alerts.
        nm.notify(tag, nextId.incrementAndGet(), n);
    }

    private Notification.Builder baseBuilder(String channel) {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, channel)
                : new Notification.Builder(this);
        return b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentIntent(openApp());
    }

    /** Tapping any of these opens the app. */
    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, intent, flags);
    }

    /** Convenience for MainActivity: hand the service a fresh configuration. */
    static void send(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && NotificationService.ACTION_START.equals(intent.getAction())) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }
}

# The Android app

A sideloadable Android build of radius, boiled down to the part that is useful on
a phone: pick a chat, read it, send a prompt, steer it, answer the two things an
agent can block on. No settings, no providers, no usage, no sub-agent management,
no TrueFoundry.

It is a **second entry point over the same engine**, not a second app. Everything
in `src/stores/opencode/` — the SSE reducer, the run-end reconciliation, steering,
transcript normalization — is shared verbatim with the desktop build. Only the
component tree differs. A fix to the engine should never need doing twice.

## Build it

Needs the Android SDK (Android Studio, or `cmdline-tools` + `platform-tools`) and
a JDK 21. Everything else is committed, including the Gradle wrapper.

```sh
npm install
npm run android:sync                      # builds dist-mobile/ and copies it into android/
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Copy the APK to the phone and open it. It is debug-signed, which is all sideloading
needs — you will have to allow "install unknown apps" for whatever opens it.

`npm run android:sync` is not optional after a web change: Gradle packages
`android/app/src/main/assets/public`, and only `cap sync` refreshes it.

## Run it against a server

On the machine running opencode2 — note `--hostname 0.0.0.0`, since the default
binds loopback and a phone is not loopback:

```sh
opencode2 serve --hostname 0.0.0.0 --port 4096
opencode2 service password
```

Then in the app: host, port, password. The host is a LAN address, a Tailscale
address, or any name the phone can resolve.

**The phone needs a route to the machine.** This is the part that doesn't come in
the APK. The desktop workflow tunnels with `ssh -L 5000:localhost:4096
ALF-UAT.coder` and points at localhost; a phone has no equivalent. In practice:

- **Tailscale** on both ends is the one that works anywhere, including off the
  office network. Use the machine's `100.x.y.z` or its `*.ts.net` name.
- **Same Wi-Fi** works for a LAN address with no extra software.
- A Coder workspace reached only through `coder ssh` is **not** reachable from the
  phone as-is. Either expose the port through Coder, or put Tailscale in the
  workspace.

## Developing without an APK

`npm run dev:mobile` serves the mobile entry on <http://127.0.0.1:5174> with the
same dev proxy the desktop uses, at the same URL shape the device serves
(`/`, not `/mobile.html`). A desktop browser's device-emulation mode is enough for
everything except the WebView itself.

To drive the *production* bundle through the *real* proxy — the closest thing to
the APK short of installing it:

```sh
npm run build:mobile && npx cap sync android
javac -d /tmp/pt android/app/src/main/java/dev/radius/mobile/LocalProxy.java \
      tools/proxy-test/ProxyTest.java tools/proxy-test/ServeBundle.java
java -cp /tmp/pt dev.radius.mobile.ServeBundle android/app/src/main/assets
# -> http://127.0.0.1:47653
```

## Why there is a proxy inside the app

This is the whole reason the port is more than a wrapper, so it is worth stating
plainly.

**The opencode2 server sends no CORS headers on any route, and answers the
OPTIONS preflight with a 404.** Verified against a live server, on an
authenticated 200 as well as a 401:

```console
$ curl -sI -u opencode:$PW -H "Origin: http://localhost" http://127.0.0.1:4096/api/health
HTTP/1.1 200 OK
Content-Type: application/json      # ← no access-control-allow-origin, on a 200
$ curl -sI -X OPTIONS -H "Origin: http://localhost" http://127.0.0.1:4096/api/session
HTTP/1.1 404 Not Found
```

So a WebView can never call the server cross-origin — not with `fetch`, not with
`EventSource`. The usual escape hatch, a native HTTP bridge plugin, does not
stream, and **every message in this app arrives over SSE**, so that hatch is
closed too.

What works instead: serve the app itself from a proxy that also forwards `/api`,
making every request same-origin. That is `LocalProxy.java` — a small HTTP server
on `127.0.0.1:47653` that serves the bundled assets and forwards
`/api/<host>:<port>/…` to the real server. It is the same thing `vite.config.js`
does in development, and it reads the target off the URL in the same format, so
the JavaScript never has to tell either proxy anything (see `apiBase()` in
`src/stores/ssh.js`).

Same-origin buys three more things for free: SSE keeps streaming, WebSocket
upgrades still work, and the PTY `connect-token`'s own same-origin check is
satisfied.

**A change to the `/api/<host>:<port>` prefix is a change in three files:**
`src/stores/ssh.js`, `vite.config.js`, `LocalProxy.java`.

### The 401 that hangs the app

Both proxies strip `WWW-Authenticate` off a 401, and this is not cosmetic.

A browser that sees `WWW-Authenticate: Basic` on a 401 opens its own credential
prompt and **leaves the fetch pending until that prompt is answered**. A WebView
shows no such prompt, so the promise never settles: one wrong password and the app
hangs on a spinner, with no error, forever. Verified in a real browser —
`credentials: "omit"` does not avoid it. With the header stripped the 401 arrives
as an ordinary response and the connect screen says "authentication failed".

## Testing the proxy

`LocalProxy.java` is the riskiest file in the port: the only new native code, on
the path of every request, and a bug in it looks from the phone like "the app
doesn't work" with no stack trace. So it carries **no Android imports** — assets
arrive through a one-method `AssetSource` interface — and is tested off-device
against a real upstream:

```sh
MOCK_PORT=4097 node test/mock-opencode.js &
javac -d /tmp/pt android/app/src/main/java/dev/radius/mobile/LocalProxy.java \
      tools/proxy-test/ProxyTest.java
java -cp /tmp/pt dev.radius.mobile.ProxyTest 4097
```

17 checks: asset serving and content types, proxying with and without the host
part, POST bodies, `Origin` not forwarded, status passthrough, an unreachable
upstream answering 502 rather than dropping the socket, the `WWW-Authenticate`
strip, **SSE arriving incrementally rather than buffered**, and a WebSocket
upgrade with bytes spliced through after the 101.

Keep this passing. It is the only test between a proxy change and a phone.

## What was left out, and what that costs

Cut because a phone is not where you do it: providers and TrueFoundry, usage
totals, sub-agent management, saved-permission review, the command palette, the
handover brief, file preview and annotation, the find bar, revert, model and agent
pickers, theming.

Cut because it cannot work: **everything reached over PTY** — git branch, `@` file
mentions, `/` local commands, sub-agent definitions, remote file read/write. Not a
CORS problem; those need a shell on the target and a WebSocket per command, which
is a poor fit for a device that suspends the moment it is pocketed. The app inherits
whatever agent and model the session already has, which is why there is no picker.

Known gaps worth naming:

- **The password is in `localStorage`**, as on the desktop. On a sideloaded app
  that is app-private storage, so it is roughly a saved password in a browser —
  fine for this, not fine if the app is ever shared.
- **"Allow always" cannot be revoked from the phone.** It writes a persisted
  server-side rule; the list that revokes it is a desktop screen. It stays
  available anyway, because approving every file read one at a time on a phone is
  unusable.
- **No background execution.** Android suspends the WebView when the app is
  backgrounded, so the SSE stream drops and reconnects on return. The run keeps
  going server-side — `GET /session/active` is what the app trusts on reconnect —
  so nothing is lost but live updates while away.
- **No push notifications.** A finished turn is visible when you open the app.
- **The proxy's port (47653) is fixed**, because `capacitor.config.json`'s
  `server.url` names it at build time. Nothing else should be on it; if something
  is, the app fails to start and says so in logcat.
